import { createHash } from "node:crypto";
import type pg from "pg";

export const migrations = [
  { version: 1, sql: `
CREATE TABLE sessions (
  sid varchar PRIMARY KEY,
  sess json NOT NULL CHECK (octet_length(sess::text) <= 16384),
  expire timestamptz NOT NULL,
  tenant_id text GENERATED ALWAYS AS (sess->>'tenantId') STORED,
  principal_id text GENERATED ALWAYS AS (sess->>'accountId') STORED
);
CREATE INDEX sessions_expire ON sessions(expire);
CREATE TABLE source_identifiers (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  source text NOT NULL CHECK (source = 'graph_packages'),
  environment_id text NOT NULL DEFAULT '',
  identifier_kind text NOT NULL CHECK (identifier_kind = 'package_id'),
  identifier_value text NOT NULL CHECK (length(identifier_value) BETWEEN 1 AND 512),
  UNIQUE(tenant_id, source, environment_id, identifier_kind, identifier_value)
);
CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  principal_id text NOT NULL,
  token_mode text NOT NULL CHECK (token_mode IN ('delegated', 'application')),
  capability text NOT NULL CHECK (capability = 'package_controls'),
  action text NOT NULL CHECK (action IN ('block','unblock','update-availability','update-installation')),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  access_update jsonb CHECK (octet_length(access_update::text) <= 65536),
  actor_name text NOT NULL,
  actor_username text NOT NULL,
  request_path text NOT NULL CHECK (length(request_path) <= 1024),
  scope text NOT NULL CHECK (scope IN ('single','bulk')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','waiting_authorization','succeeded','failed','cancelled','partial')),
  cancel_requested boolean NOT NULL DEFAULT false,
  lease_owner uuid,
  lease_version integer NOT NULL DEFAULT 0,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deadline_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '30 minutes',
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '7 days',
  UNIQUE(tenant_id, principal_id, capability, idempotency_key)
);
CREATE TABLE job_items (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 4999),
  target_id text NOT NULL CHECK (length(target_id) BETWEEN 1 AND 512),
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled','inconclusive','skipped')),
  sent_at timestamptz,
  message text CHECK (length(message) <= 1024),
  error_code text CHECK (length(error_code) <= 128),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(job_id, target_id), UNIQUE(job_id, ordinal)
);
CREATE TABLE job_attempts (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES job_items ON DELETE CASCADE,
  lease_owner uuid NOT NULL,
  lease_version integer NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sent_at timestamptz,
  finished_at timestamptz,
  outcome text CHECK (outcome IN ('succeeded','failed','cancelled','inconclusive','skipped')),
  UNIQUE(item_id, lease_version)
);
CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  event_id text NOT NULL,
  operation_id text NOT NULL,
  tenant_id text,
  principal_id text NOT NULL,
  actor_username text NOT NULL,
  actor_name text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('single','bulk')),
  action text NOT NULL CHECK (action IN ('block','unblock','update-availability','update-installation')),
  target_blocked_state boolean,
  agent_id text NOT NULL,
  agent_display_name text,
  started_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  status text NOT NULL CHECK (status IN ('started','succeeded','failed','skipped','inconclusive','cancelled')),
  message text CHECK (length(message) <= 4096),
  error_code text CHECK (length(error_code) <= 256),
  request_path text NOT NULL,
  metadata jsonb CHECK (octet_length(metadata::text) <= 16384),
  legacy_source_id text UNIQUE,
  legacy_content_hash text,
  CHECK ((action IN ('block','unblock') AND target_blocked_state IS NOT NULL)
    OR (action IN ('update-availability','update-installation') AND target_blocked_state IS NULL))
);
CREATE TABLE legacy_audit_imports (
  backup_checksum text PRIMARY KEY CHECK (backup_checksum ~ '^[a-f0-9]{64}$'),
  row_count integer NOT NULL,
  content_hash text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
` },
  { version: 2, sql: `
CREATE INDEX jobs_scope ON jobs(tenant_id, principal_id, created_at DESC);
CREATE INDEX jobs_expiry ON jobs(expires_at);
CREATE INDEX audit_events_scope ON audit_events(tenant_id, principal_id, started_at DESC);
CREATE INDEX audit_events_projection ON audit_events(event_id, observed_at DESC);
CREATE VIEW audit_projection AS
  SELECT DISTINCT ON (tenant_id, principal_id, event_id) * FROM audit_events
  ORDER BY tenant_id, principal_id, event_id, observed_at DESC, (status <> 'started') DESC, id DESC;
CREATE FUNCTION protect_job_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.tenant_id,NEW.principal_id,NEW.token_mode,NEW.capability,NEW.action,NEW.request_hash,NEW.idempotency_key,NEW.access_update,NEW.created_at,NEW.deadline_at,NEW.expires_at)
    IS DISTINCT FROM (OLD.tenant_id,OLD.principal_id,OLD.token_mode,OLD.capability,OLD.action,OLD.request_hash,OLD.idempotency_key,OLD.access_update,OLD.created_at,OLD.deadline_at,OLD.expires_at)
  THEN RAISE EXCEPTION 'job intent is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_job_intent BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION protect_job_intent();
CREATE FUNCTION protect_item_target() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.job_id,NEW.target_id,NEW.ordinal) IS DISTINCT FROM (OLD.job_id,OLD.target_id,OLD.ordinal)
  THEN RAISE EXCEPTION 'item target is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_item_target BEFORE UPDATE ON job_items FOR EACH ROW EXECUTE FUNCTION protect_item_target();
` },
  { version: 3, sql: `
ALTER TABLE jobs DISABLE TRIGGER immutable_job_intent;
ALTER TABLE jobs DROP CONSTRAINT jobs_capability_check;
UPDATE jobs SET capability=CASE WHEN action IN ('block','unblock') THEN 'graph.package.block.manage' ELSE 'graph.package.access.manage' END
  WHERE capability='package_controls';
ALTER TABLE jobs ENABLE TRIGGER immutable_job_intent;
ALTER TABLE jobs ADD CONSTRAINT jobs_capability_check CHECK (capability IN ('graph.package.access.manage','graph.package.block.manage'));
CREATE TABLE capability_configuration (
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  capability_id text NOT NULL CHECK (length(capability_id) BETWEEN 1 AND 128),
  enabled boolean NOT NULL DEFAULT false,
  shared_data_scope boolean NOT NULL DEFAULT false,
  preview_qualified boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by text NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 256),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, capability_id)
);
CREATE TABLE capability_evidence (
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  principal_id text NOT NULL CHECK (length(principal_id) BETWEEN 1 AND 256),
  capability_id text NOT NULL CHECK (length(capability_id) BETWEEN 1 AND 128),
  resource_audience text NOT NULL CHECK (length(resource_audience) BETWEEN 1 AND 256),
  environment_id text NOT NULL DEFAULT '' CHECK (length(environment_id) <= 256),
  token_mode text NOT NULL CHECK (token_mode IN ('delegated','application')),
  permission_revision text NOT NULL CHECK (length(permission_revision) BETWEEN 1 AND 128),
  configuration_revision integer NOT NULL CHECK (configuration_revision > 0),
  status text NOT NULL CHECK (status IN ('available','missing_permission','missing_internal_role','missing_role','missing_license','not_configured','unsupported','preview_disabled','provider_error','unknown')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(details::text) <= 8192),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  last_success_at timestamptz,
  PRIMARY KEY (tenant_id, principal_id, capability_id, resource_audience, environment_id, token_mode, permission_revision, configuration_revision)
);
CREATE INDEX capability_evidence_expiry ON capability_evidence(expires_at);
` },
  { version: 4, sql: `
ALTER TABLE capability_evidence ADD COLUMN authorization_principal_id text;
ALTER TABLE capability_evidence ADD COLUMN contract_revision text;
DELETE FROM capability_evidence;
ALTER TABLE capability_evidence ALTER COLUMN authorization_principal_id SET NOT NULL;
ALTER TABLE capability_evidence ALTER COLUMN contract_revision SET NOT NULL;
ALTER TABLE capability_evidence ADD CONSTRAINT capability_evidence_authorization_principal_check CHECK (length(authorization_principal_id) BETWEEN 1 AND 256);
ALTER TABLE capability_evidence ADD CONSTRAINT capability_evidence_contract_revision_check CHECK (length(contract_revision) BETWEEN 1 AND 128);
ALTER TABLE capability_evidence DROP CONSTRAINT capability_evidence_pkey;
ALTER TABLE capability_evidence ADD PRIMARY KEY (tenant_id,principal_id,authorization_principal_id,capability_id,resource_audience,environment_id,token_mode,permission_revision,contract_revision,configuration_revision);
` },
  { version: 5, sql: `
ALTER TABLE source_identifiers DROP CONSTRAINT source_identifiers_source_check;
ALTER TABLE source_identifiers DROP CONSTRAINT source_identifiers_identifier_kind_check;
ALTER TABLE source_identifiers ADD CONSTRAINT source_identifiers_source_check CHECK (source IN ('graph_packages','power_platform'));
ALTER TABLE source_identifiers ADD CONSTRAINT source_identifiers_identifier_kind_check CHECK (identifier_kind IN ('package_id','package_app_id','manifest_id','asset_id','power_platform_resource_id','cds_bot_id','entra_app_id','entra_agent_id','entra_blueprint_id','environment_id'));
CREATE TABLE power_platform_refresh_jobs (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  principal_id text NOT NULL CHECK (length(principal_id) BETWEEN 1 AND 256),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  role_scope text NOT NULL CHECK (role_scope IN ('full','ai','unknown')),
  cloud text NOT NULL DEFAULT 'global' CHECK (cloud = 'global'),
  environment_scope text NOT NULL DEFAULT '' CHECK (length(environment_scope) <= 512),
  requested_types jsonb NOT NULL CHECK (jsonb_typeof(requested_types) = 'array' AND jsonb_array_length(requested_types) BETWEEN 1 AND 11 AND octet_length(requested_types::text) <= 2048),
  status text NOT NULL DEFAULT 'waiting_authorization' CHECK (status IN ('waiting_authorization','running','succeeded','failed')),
  page_count integer NOT NULL DEFAULT 0 CHECK (page_count BETWEEN 0 AND 50),
  observed_count integer NOT NULL DEFAULT 0 CHECK (observed_count BETWEEN 0 AND 5000),
  total_records integer CHECK (total_records BETWEEN 0 AND 5000),
  unknown_field_count integer NOT NULL DEFAULT 0 CHECK (unknown_field_count BETWEEN 0 AND 1000000),
  error_code text CHECK (length(error_code) <= 128),
  message text CHECK (length(message) <= 1024),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '7 days',
  UNIQUE(tenant_id,principal_id,idempotency_key)
);
CREATE INDEX power_platform_refresh_jobs_scope ON power_platform_refresh_jobs(tenant_id,principal_id,created_at DESC);
CREATE INDEX power_platform_refresh_jobs_expiry ON power_platform_refresh_jobs(expires_at);
CREATE TABLE power_platform_inventory_snapshots (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL UNIQUE REFERENCES power_platform_refresh_jobs(id) ON DELETE RESTRICT,
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  principal_id text NOT NULL CHECK (length(principal_id) BETWEEN 1 AND 256),
  query_hash text NOT NULL CHECK (query_hash ~ '^[a-f0-9]{64}$'),
  role_scope text NOT NULL CHECK (role_scope IN ('full','ai','unknown')),
  cloud text NOT NULL DEFAULT 'global' CHECK (cloud = 'global'),
  environment_scope text NOT NULL DEFAULT '' CHECK (length(environment_scope) <= 512),
  requested_types jsonb NOT NULL CHECK (jsonb_typeof(requested_types) = 'array' AND jsonb_array_length(requested_types) BETWEEN 1 AND 11 AND octet_length(requested_types::text) <= 2048),
  coverage jsonb NOT NULL CHECK (jsonb_typeof(coverage) = 'array' AND jsonb_array_length(coverage) = 11 AND octet_length(coverage::text) <= 8192),
  observed_count integer NOT NULL CHECK (observed_count BETWEEN 0 AND 5000),
  total_records integer NOT NULL CHECK (total_records BETWEEN 0 AND 5000),
  page_count integer NOT NULL CHECK (page_count BETWEEN 1 AND 50),
  unknown_field_count integer NOT NULL CHECK (unknown_field_count BETWEEN 0 AND 1000000),
  is_current boolean NOT NULL DEFAULT true,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '30 days',
  UNIQUE(id,tenant_id,principal_id)
);
CREATE UNIQUE INDEX power_platform_inventory_current_scope ON power_platform_inventory_snapshots(tenant_id,principal_id,query_hash) WHERE is_current;
CREATE INDEX power_platform_inventory_snapshots_scope ON power_platform_inventory_snapshots(tenant_id,principal_id,is_current,observed_at DESC);
CREATE INDEX power_platform_inventory_snapshots_expiry ON power_platform_inventory_snapshots(expires_at);
CREATE TABLE power_platform_inventory_resources (
  snapshot_id uuid NOT NULL,
  tenant_id text NOT NULL,
  principal_id text NOT NULL,
  native_id text NOT NULL CHECK (length(native_id) BETWEEN 1 AND 512),
  resource_type text NOT NULL CHECK (length(resource_type) BETWEEN 1 AND 128),
  environment_id text NOT NULL DEFAULT '' CHECK (length(environment_id) <= 512),
  location text CHECK (length(location) <= 256),
  display_name text CHECK (length(display_name) <= 512),
  created_at timestamptz,
  created_by text CHECK (length(created_by) <= 512),
  last_published_at timestamptz,
  source_system text NOT NULL CHECK (source_system = 'power_platform'),
  authoring_tool text CHECK (length(authoring_tool) <= 256),
  creator_type text NOT NULL CHECK (creator_type = 'unknown'),
  agent_kind text NOT NULL CHECK (length(agent_kind) BETWEEN 1 AND 128),
  lifecycle text NOT NULL CHECK (lifecycle IN ('draft','published','unknown','not_applicable')),
  identity_confidence text NOT NULL CHECK (identity_confidence IN ('exact_native','partial')),
  identifiers jsonb NOT NULL CHECK (jsonb_typeof(identifiers) = 'array' AND jsonb_array_length(identifiers) BETWEEN 1 AND 16 AND octet_length(identifiers::text) <= 8192),
  provenance jsonb NOT NULL CHECK (jsonb_typeof(provenance) = 'object' AND octet_length(provenance::text) <= 16384),
  details jsonb NOT NULL CHECK (jsonb_typeof(details) = 'object' AND octet_length(details::text) <= 262144),
  unknown_field_count integer NOT NULL CHECK (unknown_field_count BETWEEN 0 AND 100000),
  PRIMARY KEY(snapshot_id,resource_type,environment_id,native_id),
  FOREIGN KEY(snapshot_id,tenant_id,principal_id) REFERENCES power_platform_inventory_snapshots(id,tenant_id,principal_id) ON DELETE CASCADE
);
CREATE INDEX power_platform_inventory_resources_scope ON power_platform_inventory_resources(tenant_id,principal_id,snapshot_id,resource_type,environment_id);
CREATE INDEX power_platform_inventory_resources_display ON power_platform_inventory_resources(tenant_id,principal_id,snapshot_id,lower(display_name),native_id);
` },
  { version: 6, sql: `
ALTER TABLE power_platform_inventory_snapshots DROP CONSTRAINT power_platform_inventory_snapshots_job_id_fkey;
ALTER TABLE power_platform_inventory_snapshots ALTER COLUMN job_id DROP NOT NULL;
ALTER TABLE power_platform_inventory_snapshots ADD CONSTRAINT power_platform_inventory_snapshots_job_id_fkey FOREIGN KEY(job_id) REFERENCES power_platform_refresh_jobs(id) ON DELETE SET NULL;
ALTER TABLE power_platform_refresh_jobs ADD COLUMN deadline_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '30 minutes';
CREATE INDEX power_platform_refresh_jobs_deadline ON power_platform_refresh_jobs(status,deadline_at);
ALTER TABLE source_identifiers ADD COLUMN resource_type text NOT NULL DEFAULT '' CHECK (length(resource_type) <= 128);
ALTER TABLE source_identifiers ADD COLUMN native_id text NOT NULL DEFAULT '' CHECK (length(native_id) <= 512);
UPDATE source_identifiers SET resource_type='microsoft.graph/copilotpackages',native_id=identifier_value
  WHERE source='graph_packages' AND identifier_kind='package_id';
ALTER TABLE source_identifiers DROP CONSTRAINT source_identifiers_tenant_id_source_environment_id_identifi_key;
ALTER TABLE source_identifiers ADD CONSTRAINT source_identifiers_scoped_identity UNIQUE(tenant_id,source,resource_type,environment_id,native_id,identifier_kind,identifier_value);
` },
  { version: 7, sql: `
CREATE TABLE package_refresh_jobs (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  principal_id text NOT NULL CHECK (length(principal_id) BETWEEN 1 AND 256),
  authorization_principal_id text NOT NULL CHECK (length(authorization_principal_id) BETWEEN 1 AND 256),
  token_mode text NOT NULL CHECK (token_mode IN ('delegated','application')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  query_hash text NOT NULL CHECK (query_hash ~ '^[a-f0-9]{64}$'),
  scope_kind text NOT NULL CHECK (scope_kind IN ('broad','exact')),
  requested_ids jsonb NOT NULL CHECK (jsonb_typeof(requested_ids)='array' AND jsonb_array_length(requested_ids) BETWEEN 0 AND 5000 AND octet_length(requested_ids::text) <= 2580000),
  status text NOT NULL DEFAULT 'waiting_authorization' CHECK (status IN ('waiting_authorization','running','succeeded','failed')),
  page_count integer NOT NULL DEFAULT 0 CHECK (page_count BETWEEN 0 AND 100),
  observed_count integer NOT NULL DEFAULT 0 CHECK (observed_count BETWEEN 0 AND 5000),
  total_records integer CHECK (total_records BETWEEN 0 AND 5000),
  error_code text CHECK (length(error_code) <= 128),
  message text CHECK (length(message) <= 1024),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  deadline_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '30 minutes',
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '7 days',
  UNIQUE(tenant_id,principal_id,token_mode,idempotency_key),
  CHECK ((scope_kind='broad' AND jsonb_array_length(requested_ids)=0) OR (scope_kind='exact' AND jsonb_array_length(requested_ids)>0))
);
CREATE INDEX package_refresh_jobs_scope ON package_refresh_jobs(tenant_id,principal_id,created_at DESC);
CREATE INDEX package_refresh_jobs_expiry ON package_refresh_jobs(expires_at);
CREATE INDEX package_refresh_jobs_recovery ON package_refresh_jobs(status,deadline_at);
CREATE TABLE package_inventory_snapshots (
  id uuid PRIMARY KEY,
  job_id uuid UNIQUE REFERENCES package_refresh_jobs(id) ON DELETE SET NULL,
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  principal_id text NOT NULL CHECK (length(principal_id) BETWEEN 1 AND 256),
  token_mode text NOT NULL CHECK (token_mode IN ('delegated','application')),
  query_hash text NOT NULL CHECK (query_hash ~ '^[a-f0-9]{64}$'),
  scope_kind text NOT NULL CHECK (scope_kind IN ('broad','exact')),
  requested_ids jsonb NOT NULL CHECK (jsonb_typeof(requested_ids)='array' AND jsonb_array_length(requested_ids) BETWEEN 0 AND 5000 AND octet_length(requested_ids::text) <= 2580000),
  observed_count integer NOT NULL CHECK (observed_count BETWEEN 0 AND 5000),
  total_records integer NOT NULL CHECK (total_records BETWEEN 0 AND 5000),
  page_count integer NOT NULL CHECK (page_count BETWEEN 1 AND 100),
  is_current boolean NOT NULL DEFAULT true,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '30 days',
  UNIQUE(id,tenant_id,principal_id),
  CHECK ((scope_kind='broad' AND jsonb_array_length(requested_ids)=0) OR (scope_kind='exact' AND jsonb_array_length(requested_ids)>0))
);
CREATE UNIQUE INDEX package_inventory_current_scope ON package_inventory_snapshots(tenant_id,principal_id,token_mode,query_hash) WHERE is_current;
CREATE INDEX package_inventory_snapshots_scope ON package_inventory_snapshots(tenant_id,principal_id,is_current,observed_at DESC);
CREATE INDEX package_inventory_snapshots_expiry ON package_inventory_snapshots(expires_at);
CREATE TABLE package_inventory_resources (
  snapshot_id uuid NOT NULL,
  tenant_id text NOT NULL,
  principal_id text NOT NULL,
  native_id text NOT NULL CHECK (length(native_id) BETWEEN 1 AND 512),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 256),
  is_blocked boolean NOT NULL,
  available_to text CHECK (length(available_to) <= 128),
  deployed_to text CHECK (length(deployed_to) <= 128),
  publisher text CHECK (length(publisher) <= 4096),
  last_modified_at timestamptz,
  identifiers jsonb NOT NULL CHECK (jsonb_typeof(identifiers)='array' AND jsonb_array_length(identifiers) BETWEEN 1 AND 4 AND octet_length(identifiers::text) <= 8192),
  package_data jsonb NOT NULL CHECK (jsonb_typeof(package_data)='object' AND octet_length(package_data::text) <= 1048576),
  PRIMARY KEY(snapshot_id,native_id),
  FOREIGN KEY(snapshot_id,tenant_id,principal_id) REFERENCES package_inventory_snapshots(id,tenant_id,principal_id) ON DELETE CASCADE
);
CREATE INDEX package_inventory_resources_scope ON package_inventory_resources(tenant_id,principal_id,snapshot_id,native_id);
CREATE INDEX package_inventory_resources_display ON package_inventory_resources(tenant_id,principal_id,snapshot_id,lower(display_name),native_id);
` },
  { version: 8, sql: `
ALTER TABLE jobs DROP CONSTRAINT jobs_action_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_action_check CHECK (action IN ('block','unblock','update-availability','update-installation','reassign'));
ALTER TABLE jobs ADD COLUMN confirmation_hash text CHECK (confirmation_hash ~ '^[a-f0-9]{64}$');
ALTER TABLE jobs ADD COLUMN confirmation_summary jsonb CHECK (jsonb_typeof(confirmation_summary)='object' AND octet_length(confirmation_summary::text) <= 65536);
ALTER TABLE jobs ADD COLUMN confirmed_at timestamptz;
ALTER TABLE jobs ADD COLUMN reassign_user_id text CHECK (length(reassign_user_id) BETWEEN 1 AND 512);
ALTER TABLE jobs ADD CONSTRAINT jobs_confirmation_complete CHECK (
  (confirmation_hash IS NULL AND confirmation_summary IS NULL AND confirmed_at IS NULL)
  OR (confirmation_hash IS NOT NULL AND confirmation_summary IS NOT NULL AND confirmed_at IS NOT NULL));
ALTER TABLE jobs ADD CONSTRAINT jobs_reassignment_intent CHECK (
  (action='reassign' AND reassign_user_id IS NOT NULL AND access_update IS NULL)
  OR (action<>'reassign' AND reassign_user_id IS NULL));
ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE audit_events DROP CONSTRAINT audit_events_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_check CHECK (action IN ('block','unblock','update-availability','update-installation','reassign'));
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_state CHECK (
  (action IN ('block','unblock') AND target_blocked_state IS NOT NULL)
  OR (action IN ('update-availability','update-installation','reassign') AND target_blocked_state IS NULL));
CREATE OR REPLACE FUNCTION protect_job_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.tenant_id,NEW.principal_id,NEW.token_mode,NEW.capability,NEW.action,NEW.request_hash,NEW.idempotency_key,NEW.access_update,NEW.confirmation_hash,NEW.confirmation_summary,NEW.confirmed_at,NEW.reassign_user_id,NEW.created_at,NEW.deadline_at,NEW.expires_at)
    IS DISTINCT FROM (OLD.tenant_id,OLD.principal_id,OLD.token_mode,OLD.capability,OLD.action,OLD.request_hash,OLD.idempotency_key,OLD.access_update,OLD.confirmation_hash,OLD.confirmation_summary,OLD.confirmed_at,OLD.reassign_user_id,OLD.created_at,OLD.deadline_at,OLD.expires_at)
  THEN RAISE EXCEPTION 'job intent is immutable'; END IF;
  RETURN NEW;
END $$;
ALTER TABLE job_items ADD COLUMN prestate_hash text CHECK (prestate_hash ~ '^[a-f0-9]{64}$');
ALTER TABLE job_items ADD COLUMN prestate jsonb CHECK (jsonb_typeof(prestate)='object' AND octet_length(prestate::text) <= 65536);
ALTER TABLE job_items ADD COLUMN poststate_hash text CHECK (poststate_hash ~ '^[a-f0-9]{64}$');
ALTER TABLE job_items ADD COLUMN poststate jsonb CHECK (jsonb_typeof(poststate)='object' AND octet_length(poststate::text) <= 65536);
ALTER TABLE job_items ADD COLUMN correlation_id uuid;
ALTER TABLE job_items ADD COLUMN reconciliation_status text NOT NULL DEFAULT 'not_required' CHECK (reconciliation_status IN ('not_required','required','verified_applied','verified_not_applied','conflict'));
ALTER TABLE job_items ADD COLUMN reconciled_at timestamptz;
ALTER TABLE job_items ADD CONSTRAINT job_items_prestate_complete CHECK ((prestate_hash IS NULL)=(prestate IS NULL));
ALTER TABLE job_items ADD CONSTRAINT job_items_poststate_complete CHECK ((poststate_hash IS NULL)=(poststate IS NULL));
ALTER TABLE job_items ADD CONSTRAINT job_items_reconciliation_complete CHECK (
  (reconciliation_status IN ('not_required','required') AND reconciled_at IS NULL)
  OR (reconciliation_status IN ('verified_applied','verified_not_applied','conflict') AND reconciled_at IS NOT NULL));
CREATE OR REPLACE FUNCTION protect_item_target() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.job_id,NEW.target_id,NEW.display_name,NEW.ordinal,NEW.prestate_hash,NEW.prestate)
    IS DISTINCT FROM (OLD.job_id,OLD.target_id,OLD.display_name,OLD.ordinal,OLD.prestate_hash,OLD.prestate)
  THEN RAISE EXCEPTION 'item target is immutable'; END IF;
  RETURN NEW;
END $$;
ALTER TABLE job_attempts ADD COLUMN correlation_id uuid;
ALTER TABLE job_attempts ADD COLUMN prestate_hash text CHECK (prestate_hash ~ '^[a-f0-9]{64}$');
ALTER TABLE job_attempts ADD COLUMN readback_count integer NOT NULL DEFAULT 0 CHECK (readback_count BETWEEN 0 AND 20);
CREATE TABLE package_mutation_qualifications (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  target_id text NOT NULL CHECK (length(target_id) BETWEEN 1 AND 512),
  target_type text NOT NULL CHECK (target_type IN ('copilot_package')),
  action text NOT NULL CHECK (action IN ('block','unblock','update-availability','update-installation','reassign')),
  actor_principal_id text NOT NULL CHECK (length(actor_principal_id) BETWEEN 1 AND 256),
  actor_name text NOT NULL CHECK (length(actor_name) BETWEEN 1 AND 256),
  approved_by text NOT NULL CHECK (length(approved_by) BETWEEN 1 AND 256),
  contract_revision text NOT NULL CHECK (length(contract_revision) BETWEEN 1 AND 128),
  configuration_revision integer NOT NULL CHECK (configuration_revision > 0),
  auth_mode text NOT NULL CHECK (auth_mode='delegated'),
  prestate jsonb NOT NULL CHECK (jsonb_typeof(prestate)='object' AND octet_length(prestate::text) <= 65536),
  poststate jsonb NOT NULL CHECK (jsonb_typeof(poststate)='object' AND octet_length(poststate::text) <= 65536),
  restoration_criteria jsonb NOT NULL CHECK (jsonb_typeof(restoration_criteria)='object' AND octet_length(restoration_criteria::text) <= 65536),
  status text NOT NULL CHECK (status IN ('qualified','restoration_conflict','failed','expired')),
  qualified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  restored_at timestamptz,
  CHECK (expires_at > qualified_at),
  CHECK ((status='qualified' AND restored_at IS NOT NULL) OR status<>'qualified')
);
CREATE INDEX package_mutation_qualifications_scope ON package_mutation_qualifications(tenant_id,action,status,expires_at DESC);
CREATE UNIQUE INDEX package_mutation_qualification_current ON package_mutation_qualifications(tenant_id,action,contract_revision,configuration_revision,auth_mode) WHERE status='qualified';
` },
  { version: 9, sql: `
ALTER TABLE audit_events DROP CONSTRAINT audit_events_status_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_status_check CHECK (status IN ('requested','started','succeeded','failed','skipped','inconclusive','cancelled'));
` },
  { version: 10, sql: `
ALTER TABLE package_mutation_qualifications ALTER COLUMN actor_principal_id DROP NOT NULL;
ALTER TABLE package_mutation_qualifications ALTER COLUMN actor_name DROP NOT NULL;
ALTER TABLE package_mutation_qualifications ADD COLUMN workflow_version smallint NOT NULL DEFAULT 1 CHECK (workflow_version IN (1,2));
ALTER TABLE package_mutation_qualifications ADD COLUMN approved_by_principal_id text CHECK (approved_by_principal_id IS NULL OR length(approved_by_principal_id) BETWEEN 1 AND 256);
ALTER TABLE package_mutation_qualifications ADD COLUMN correlation_id uuid;
ALTER TABLE package_mutation_qualifications ADD COLUMN attempted_at timestamptz;
ALTER TABLE package_mutation_qualifications ADD COLUMN error_code text CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 128);
ALTER TABLE package_mutation_qualifications ADD COLUMN message text CHECK (message IS NULL OR length(message) BETWEEN 1 AND 1024);
ALTER TABLE package_mutation_qualifications DROP CONSTRAINT package_mutation_qualifications_status_check;
ALTER TABLE package_mutation_qualifications DROP CONSTRAINT package_mutation_qualifications_check1;
ALTER TABLE package_mutation_qualifications ADD CONSTRAINT package_mutation_qualifications_status_check CHECK (
  status IN ('approved','restoring','qualified','restoration_conflict','failed','inconclusive','expired'));
ALTER TABLE package_mutation_qualifications ADD CONSTRAINT package_mutation_qualifications_workflow_check CHECK (
  (workflow_version=1 AND status IN ('qualified','restoration_conflict','failed','expired') AND ((status='qualified' AND restored_at IS NOT NULL) OR status<>'qualified'))
  OR (workflow_version=2 AND approved_by_principal_id IS NOT NULL AND (
    (status='approved' AND actor_principal_id IS NULL AND actor_name IS NULL AND correlation_id IS NULL AND attempted_at IS NULL AND restored_at IS NULL AND error_code IS NULL)
    OR (status='restoring' AND actor_principal_id IS NOT NULL AND actor_name IS NOT NULL AND correlation_id IS NOT NULL AND attempted_at IS NOT NULL AND restored_at IS NULL AND error_code IS NULL)
    OR (status='qualified' AND actor_principal_id IS NOT NULL AND actor_name IS NOT NULL AND correlation_id IS NOT NULL AND attempted_at IS NOT NULL AND restored_at IS NOT NULL AND error_code IS NULL)
    OR (status IN ('restoration_conflict','failed','inconclusive') AND actor_principal_id IS NOT NULL AND actor_name IS NOT NULL AND correlation_id IS NOT NULL AND attempted_at IS NOT NULL AND restored_at IS NULL AND error_code IS NOT NULL)
    OR status='expired')));
` },
  { version: 11, sql: `
UPDATE package_mutation_qualifications SET status='inconclusive',error_code='workflow_invalidated',
  message='The prior canary workflow was interrupted and cannot be resumed.',expires_at=clock_timestamp()+interval '30 days'
  WHERE workflow_version=2 AND status='restoring';
UPDATE package_mutation_qualifications SET status='expired'
  WHERE workflow_version IN (1,2) AND status='qualified';
ALTER TABLE package_mutation_qualifications DROP CONSTRAINT package_mutation_qualifications_workflow_version_check;
ALTER TABLE package_mutation_qualifications DROP CONSTRAINT package_mutation_qualifications_workflow_check;
ALTER TABLE package_mutation_qualifications ADD COLUMN paired_qualification_id uuid REFERENCES package_mutation_qualifications(id);
ALTER TABLE package_mutation_qualifications ADD COLUMN job_id uuid REFERENCES jobs(id) ON DELETE SET NULL;
ALTER TABLE package_mutation_qualifications ADD COLUMN cycle_stage text CHECK (cycle_stage IN ('original','restoration'));
ALTER TABLE package_mutation_qualifications ADD CONSTRAINT package_mutation_qualifications_workflow_version_check CHECK (workflow_version IN (1,2,3));
ALTER TABLE package_mutation_qualifications ADD CONSTRAINT package_mutation_qualifications_workflow_check CHECK (
  (workflow_version=1 AND status IN ('restoration_conflict','failed','expired'))
  OR (workflow_version=2 AND approved_by_principal_id IS NOT NULL AND status<>'qualified')
  OR (workflow_version=3 AND approved_by_principal_id IS NOT NULL AND (
    (status='approved' AND actor_principal_id IS NULL AND actor_name IS NULL AND correlation_id IS NULL AND attempted_at IS NULL AND restored_at IS NULL AND error_code IS NULL AND paired_qualification_id IS NULL AND job_id IS NULL AND cycle_stage IS NULL)
    OR (status='restoring' AND actor_principal_id IS NOT NULL AND actor_name IS NOT NULL AND correlation_id IS NOT NULL AND attempted_at IS NOT NULL AND restored_at IS NULL AND error_code IS NULL AND paired_qualification_id IS NOT NULL AND cycle_stage IS NOT NULL)
    OR (status='qualified' AND actor_principal_id IS NOT NULL AND actor_name IS NOT NULL AND correlation_id IS NOT NULL AND attempted_at IS NOT NULL AND restored_at IS NOT NULL AND error_code IS NULL AND paired_qualification_id IS NOT NULL AND job_id IS NOT NULL AND cycle_stage IS NOT NULL)
    OR (status IN ('restoration_conflict','failed','inconclusive') AND actor_principal_id IS NOT NULL AND actor_name IS NOT NULL AND correlation_id IS NOT NULL AND attempted_at IS NOT NULL AND restored_at IS NULL AND error_code IS NOT NULL AND paired_qualification_id IS NOT NULL AND cycle_stage IS NOT NULL)
    OR status='expired')));
CREATE INDEX package_mutation_qualifications_job ON package_mutation_qualifications(job_id) WHERE job_id IS NOT NULL;
` },
  { version: 12, sql: `
ALTER TABLE package_mutation_qualifications DROP CONSTRAINT package_mutation_qualifications_job_id_fkey;
ALTER TABLE package_mutation_qualifications DROP CONSTRAINT package_mutation_qualifications_paired_qualification_id_fkey;
ALTER TABLE package_mutation_qualifications ADD CONSTRAINT package_mutation_qualifications_paired_qualification_id_fkey
  FOREIGN KEY (paired_qualification_id) REFERENCES package_mutation_qualifications(id) ON DELETE CASCADE;
` },
  { version: 13, sql: `
CREATE TABLE official_usage_staging (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  actor_principal_id text NOT NULL CHECK (length(actor_principal_id) BETWEEN 1 AND 256),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','accepted','replaced','expired','cancelled')),
  kind text NOT NULL CHECK (kind IN ('agents','userAgents','users')),
  file_hash text NOT NULL CHECK (file_hash ~ '^[a-f0-9]{64}$'),
  parser_version text NOT NULL CHECK (length(parser_version) BETWEEN 1 AND 64),
  schema_version text NOT NULL CHECK (length(schema_version) BETWEEN 1 AND 128),
  bundle_id uuid NOT NULL,
  correction_of_set_id uuid,
  reporting_start date NOT NULL,
  reporting_end date NOT NULL,
  period_provenance text NOT NULL CHECK (period_provenance IN ('source_metadata','operator_asserted')),
  source_as_of timestamptz,
  source_as_of_provenance text NOT NULL CHECK (source_as_of_provenance IN ('source_metadata','operator_asserted','absent')),
  source_freshness text NOT NULL CHECK (source_freshness IN ('known','unknown')),
  downloaded_at timestamptz,
  row_count integer NOT NULL CHECK (row_count BETWEEN 0 AND 50000),
  stored_bytes integer NOT NULL CHECK (stored_bytes BETWEEN 2 AND 33554432),
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(warnings)='array' AND jsonb_array_length(warnings)<=100 AND octet_length(warnings::text)<=32768),
  reconciliation jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(reconciliation)='object' AND octet_length(reconciliation::text)<=32768),
  active_revision bigint NOT NULL CHECK (active_revision > 0),
  accepted_version_id uuid,
  accepted_set_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '30 minutes',
  accepted_at timestamptz,
  CHECK (reporting_start <= reporting_end),
  CHECK ((source_as_of IS NULL AND source_as_of_provenance='absent' AND source_freshness='unknown') OR
    (source_as_of IS NOT NULL AND source_as_of_provenance='source_metadata' AND source_freshness='known') OR
    (source_as_of IS NOT NULL AND source_as_of_provenance='operator_asserted' AND source_freshness='unknown')),
  CHECK ((status='accepted' AND accepted_version_id IS NOT NULL AND accepted_set_id IS NOT NULL AND accepted_at IS NOT NULL) OR
    (status<>'accepted' AND accepted_version_id IS NULL AND accepted_set_id IS NULL AND accepted_at IS NULL))
);
CREATE INDEX official_usage_staging_owner ON official_usage_staging(tenant_id,actor_principal_id,status,created_at DESC);
CREATE INDEX official_usage_staging_expiry ON official_usage_staging(status,expires_at);
ALTER TABLE official_usage_staging ADD CONSTRAINT official_usage_staging_scope_unique UNIQUE(id,tenant_id,actor_principal_id);
CREATE TABLE official_usage_staged_rows (
  staging_id uuid NOT NULL REFERENCES official_usage_staging(id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  actor_principal_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 49999),
  row_data jsonb NOT NULL CHECK (jsonb_typeof(row_data)='object' AND octet_length(row_data::text)<=16384),
  PRIMARY KEY(staging_id,ordinal),
  FOREIGN KEY(staging_id,tenant_id,actor_principal_id) REFERENCES official_usage_staging(id,tenant_id,actor_principal_id) ON DELETE CASCADE
);
CREATE TABLE official_usage_artifacts (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  kind text NOT NULL CHECK (kind IN ('agents','userAgents','users')),
  file_hash text NOT NULL CHECK (file_hash ~ '^[a-f0-9]{64}$'),
  parser_version text NOT NULL CHECK (length(parser_version) BETWEEN 1 AND 64),
  schema_version text NOT NULL CHECK (length(schema_version) BETWEEN 1 AND 128),
  first_accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '180 days',
  UNIQUE(tenant_id,kind,file_hash),
  UNIQUE(id,tenant_id,kind)
);
CREATE INDEX official_usage_artifacts_expiry ON official_usage_artifacts(expires_at);
CREATE TABLE official_usage_sets (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  bundle_id uuid NOT NULL,
  reporting_start date NOT NULL,
  reporting_end date NOT NULL,
  supersedes_set_id uuid,
  complete boolean NOT NULL DEFAULT false,
  accepted_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '180 days',
  CHECK (reporting_start <= reporting_end),
  CHECK ((complete AND accepted_at IS NOT NULL) OR (NOT complete AND accepted_at IS NULL)),
  UNIQUE(tenant_id,bundle_id),
  UNIQUE(id,tenant_id)
);
CREATE INDEX official_usage_sets_scope ON official_usage_sets(tenant_id,created_at DESC);
CREATE INDEX official_usage_sets_expiry ON official_usage_sets(expires_at,deleted_at);
CREATE TABLE official_usage_versions (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  artifact_id uuid NOT NULL,
  staging_id uuid NOT NULL UNIQUE REFERENCES official_usage_staging(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('agents','userAgents','users')),
  reporting_start date NOT NULL,
  reporting_end date NOT NULL,
  period_provenance text NOT NULL CHECK (period_provenance IN ('source_metadata','operator_asserted')),
  source_as_of timestamptz,
  source_as_of_provenance text NOT NULL CHECK (source_as_of_provenance IN ('source_metadata','operator_asserted','absent')),
  source_freshness text NOT NULL CHECK (source_freshness IN ('known','unknown')),
  downloaded_at timestamptz,
  row_count integer NOT NULL CHECK (row_count BETWEEN 0 AND 50000),
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(warnings)='array' AND jsonb_array_length(warnings)<=100 AND octet_length(warnings::text)<=32768),
  accepted_by text NOT NULL CHECK (length(accepted_by) BETWEEN 1 AND 256),
  supersedes_version_id uuid,
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '180 days',
  CHECK (reporting_start <= reporting_end),
  FOREIGN KEY(artifact_id,tenant_id,kind) REFERENCES official_usage_artifacts(id,tenant_id,kind) ON DELETE RESTRICT,
  UNIQUE(id,tenant_id,kind)
);
CREATE INDEX official_usage_versions_scope ON official_usage_versions(tenant_id,kind,accepted_at DESC);
CREATE INDEX official_usage_versions_expiry ON official_usage_versions(expires_at,deleted_at);
CREATE TABLE official_usage_version_rows (
  version_id uuid NOT NULL,
  tenant_id text NOT NULL,
  kind text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 49999),
  row_data jsonb NOT NULL CHECK (jsonb_typeof(row_data)='object' AND octet_length(row_data::text)<=16384),
  PRIMARY KEY(version_id,ordinal),
  FOREIGN KEY(version_id,tenant_id,kind) REFERENCES official_usage_versions(id,tenant_id,kind) ON DELETE CASCADE
);
CREATE INDEX official_usage_version_rows_scope ON official_usage_version_rows(tenant_id,kind,version_id,ordinal);
CREATE TABLE official_usage_set_versions (
  set_id uuid NOT NULL,
  tenant_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('agents','userAgents','users')),
  version_id uuid NOT NULL,
  PRIMARY KEY(set_id,kind),
  UNIQUE(version_id),
  FOREIGN KEY(set_id,tenant_id) REFERENCES official_usage_sets(id,tenant_id) ON DELETE CASCADE,
  FOREIGN KEY(version_id,tenant_id,kind) REFERENCES official_usage_versions(id,tenant_id,kind) ON DELETE RESTRICT
);
CREATE INDEX official_usage_set_versions_scope ON official_usage_set_versions(tenant_id,set_id,kind);
CREATE TABLE official_usage_state (
  tenant_id text PRIMARY KEY CHECK (length(tenant_id) BETWEEN 1 AND 128),
  active_set_id uuid,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(active_set_id,tenant_id) REFERENCES official_usage_sets(id,tenant_id) ON DELETE RESTRICT
);
CREATE TABLE official_usage_confirmations (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  actor_principal_id text NOT NULL CHECK (length(actor_principal_id) BETWEEN 1 AND 256),
  operation text NOT NULL CHECK (operation IN ('select','delete')),
  target_set_id uuid NOT NULL,
  expected_revision bigint NOT NULL CHECK (expected_revision > 0),
  confirmation_hash text NOT NULL CHECK (confirmation_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '10 minutes',
  consumed_at timestamptz,
  FOREIGN KEY(target_set_id,tenant_id) REFERENCES official_usage_sets(id,tenant_id) ON DELETE CASCADE
);
CREATE INDEX official_usage_confirmations_owner ON official_usage_confirmations(tenant_id,actor_principal_id,expires_at);
CREATE TABLE official_usage_audit (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  actor_principal_id text NOT NULL CHECK (length(actor_principal_id) BETWEEN 1 AND 256),
  action text NOT NULL CHECK (action IN ('staged','accepted','selected','deleted','discarded','legacy_cleanup_acknowledged')),
  target_kind text CHECK (target_kind IS NULL OR target_kind IN ('agents','userAgents','users')),
  target_id uuid,
  row_count integer CHECK (row_count BETWEEN 0 AND 50000),
  outcome text NOT NULL CHECK (outcome IN ('succeeded','rejected')),
  error_code text CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 128),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '90 days'
);
CREATE INDEX official_usage_audit_scope ON official_usage_audit(tenant_id,actor_principal_id,observed_at DESC);
CREATE INDEX official_usage_audit_expiry ON official_usage_audit(expires_at);
CREATE FUNCTION protect_official_usage_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.tenant_id,NEW.artifact_id,NEW.staging_id,NEW.kind,NEW.reporting_start,NEW.reporting_end,NEW.period_provenance,NEW.source_as_of,NEW.source_as_of_provenance,NEW.source_freshness,NEW.downloaded_at,NEW.row_count,NEW.warnings,NEW.accepted_by,NEW.supersedes_version_id,NEW.accepted_at)
    IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.artifact_id,OLD.staging_id,OLD.kind,OLD.reporting_start,OLD.reporting_end,OLD.period_provenance,OLD.source_as_of,OLD.source_as_of_provenance,OLD.source_freshness,OLD.downloaded_at,OLD.row_count,OLD.warnings,OLD.accepted_by,OLD.supersedes_version_id,OLD.accepted_at)
  THEN RAISE EXCEPTION 'official usage version is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_official_usage_version BEFORE UPDATE ON official_usage_versions FOR EACH ROW EXECUTE FUNCTION protect_official_usage_version();
` },
  { version: 14, sql: `
ALTER TABLE official_usage_versions DROP CONSTRAINT official_usage_versions_staging_id_fkey;
ALTER TABLE official_usage_versions ADD COLUMN reconciliation jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(reconciliation)='object' AND octet_length(reconciliation::text)<=32768);
UPDATE official_usage_versions version SET reconciliation=staging.reconciliation
  FROM official_usage_staging staging WHERE staging.id=version.staging_id;
CREATE OR REPLACE FUNCTION protect_official_usage_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.tenant_id,NEW.artifact_id,NEW.staging_id,NEW.kind,NEW.reporting_start,NEW.reporting_end,
      NEW.period_provenance,NEW.source_as_of,NEW.source_as_of_provenance,NEW.source_freshness,NEW.downloaded_at,
      NEW.row_count,NEW.warnings,NEW.reconciliation,NEW.accepted_by,NEW.supersedes_version_id,NEW.accepted_at)
    IS DISTINCT FROM
     (OLD.id,OLD.tenant_id,OLD.artifact_id,OLD.staging_id,OLD.kind,OLD.reporting_start,OLD.reporting_end,
      OLD.period_provenance,OLD.source_as_of,OLD.source_as_of_provenance,OLD.source_freshness,OLD.downloaded_at,
      OLD.row_count,OLD.warnings,OLD.reconciliation,OLD.accepted_by,OLD.supersedes_version_id,OLD.accepted_at)
  THEN RAISE EXCEPTION 'official usage version is immutable'; END IF;
  RETURN NEW;
END $$;

ALTER TABLE official_usage_sets ADD COLUMN actor_principal_id text;
UPDATE official_usage_sets report_set SET actor_principal_id=COALESCE(
  (SELECT version.accepted_by FROM official_usage_set_versions membership
    JOIN official_usage_versions version ON version.id=membership.version_id
    WHERE membership.set_id=report_set.id ORDER BY membership.kind LIMIT 1),
  (SELECT staging.actor_principal_id FROM official_usage_staging staging
    WHERE staging.accepted_set_id=report_set.id ORDER BY staging.accepted_at LIMIT 1),
  'migration-13');
ALTER TABLE official_usage_sets ALTER COLUMN actor_principal_id SET NOT NULL;
ALTER TABLE official_usage_sets ADD CONSTRAINT official_usage_sets_actor_check
  CHECK (length(actor_principal_id) BETWEEN 1 AND 256);

ALTER TABLE official_usage_staging ADD COLUMN accepted_result_revision bigint;
UPDATE official_usage_staging SET accepted_result_revision=active_revision WHERE status='accepted';
ALTER TABLE official_usage_staging ADD CONSTRAINT official_usage_staging_receipt_check CHECK (
  (status='accepted' AND accepted_result_revision IS NOT NULL AND accepted_result_revision>0)
  OR (status<>'accepted' AND accepted_result_revision IS NULL));

CREATE FUNCTION protect_official_usage_staging() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user<>'agentcontrol_app' THEN RETURN NEW; END IF;
  IF (NEW.id,NEW.tenant_id,NEW.actor_principal_id,NEW.revision,NEW.kind,NEW.file_hash,NEW.parser_version,
      NEW.schema_version,NEW.bundle_id,NEW.correction_of_set_id,NEW.reporting_start,NEW.reporting_end,
      NEW.period_provenance,NEW.source_as_of,NEW.source_as_of_provenance,NEW.source_freshness,
      NEW.downloaded_at,NEW.row_count,NEW.stored_bytes,NEW.warnings,NEW.reconciliation,
      NEW.active_revision,NEW.created_at,NEW.expires_at)
    IS DISTINCT FROM
     (OLD.id,OLD.tenant_id,OLD.actor_principal_id,OLD.revision,OLD.kind,OLD.file_hash,OLD.parser_version,
      OLD.schema_version,OLD.bundle_id,OLD.correction_of_set_id,OLD.reporting_start,OLD.reporting_end,
      OLD.period_provenance,OLD.source_as_of,OLD.source_as_of_provenance,OLD.source_freshness,
      OLD.downloaded_at,OLD.row_count,OLD.stored_bytes,OLD.warnings,OLD.reconciliation,
      OLD.active_revision,OLD.created_at,OLD.expires_at)
  THEN RAISE EXCEPTION 'official usage staging intent is immutable'; END IF;
  IF OLD.status<>'active' OR NEW.status NOT IN ('accepted','replaced','expired','cancelled')
  THEN RAISE EXCEPTION 'official usage staging transition is invalid'; END IF;
  IF NEW.status='accepted' THEN
    IF NEW.accepted_version_id IS NULL OR NEW.accepted_set_id IS NULL OR NEW.accepted_at IS NULL OR NEW.accepted_result_revision IS NULL
    THEN RAISE EXCEPTION 'official usage acceptance receipt is incomplete'; END IF;
  ELSIF (NEW.accepted_version_id,NEW.accepted_set_id,NEW.accepted_at,NEW.accepted_result_revision)
    IS DISTINCT FROM (OLD.accepted_version_id,OLD.accepted_set_id,OLD.accepted_at,OLD.accepted_result_revision)
  THEN RAISE EXCEPTION 'official usage staging receipt is invalid'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_official_usage_staging BEFORE UPDATE ON official_usage_staging
  FOR EACH ROW EXECUTE FUNCTION protect_official_usage_staging();

CREATE FUNCTION protect_official_usage_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user<>'agentcontrol_app' THEN RETURN NEW; END IF;
  IF (NEW.id,NEW.tenant_id,NEW.kind,NEW.file_hash,NEW.parser_version,NEW.schema_version,NEW.first_accepted_at)
    IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.kind,OLD.file_hash,OLD.parser_version,OLD.schema_version,OLD.first_accepted_at)
    OR NEW.expires_at<OLD.expires_at
  THEN RAISE EXCEPTION 'official usage artifact is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_official_usage_artifact BEFORE UPDATE ON official_usage_artifacts
  FOR EACH ROW EXECUTE FUNCTION protect_official_usage_artifact();

CREATE FUNCTION protect_official_usage_set() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user<>'agentcontrol_app' THEN RETURN NEW; END IF;
  IF (NEW.id,NEW.tenant_id,NEW.bundle_id,NEW.actor_principal_id,NEW.reporting_start,NEW.reporting_end,
      NEW.supersedes_set_id,NEW.created_at,NEW.expires_at)
    IS DISTINCT FROM
     (OLD.id,OLD.tenant_id,OLD.bundle_id,OLD.actor_principal_id,OLD.reporting_start,OLD.reporting_end,
      OLD.supersedes_set_id,OLD.created_at,OLD.expires_at)
  THEN RAISE EXCEPTION 'official usage set identity is immutable'; END IF;
  IF OLD.complete AND (NOT NEW.complete OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at)
  THEN RAISE EXCEPTION 'official usage set completion is immutable'; END IF;
  IF NOT OLD.complete AND NEW.complete AND NEW.accepted_at IS NULL
  THEN RAISE EXCEPTION 'official usage set completion requires acceptance time'; END IF;
  IF NOT OLD.complete AND NOT NEW.complete AND NEW.accepted_at IS DISTINCT FROM OLD.accepted_at
  THEN RAISE EXCEPTION 'official usage incomplete set cannot have acceptance time'; END IF;
  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
  THEN RAISE EXCEPTION 'official usage set deletion is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_official_usage_set BEFORE UPDATE ON official_usage_sets
  FOR EACH ROW EXECUTE FUNCTION protect_official_usage_set();

CREATE FUNCTION protect_official_usage_membership() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_deleted timestamptz; parent_complete boolean;
BEGIN
  IF current_user<>'agentcontrol_app' THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
  IF TG_OP='INSERT' THEN
    SELECT deleted_at,complete INTO parent_deleted,parent_complete FROM official_usage_sets
      WHERE id=NEW.set_id AND tenant_id=NEW.tenant_id;
    IF parent_deleted IS NOT NULL OR parent_complete
    THEN RAISE EXCEPTION 'official usage complete or deleted set membership is immutable'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'official usage set membership is immutable'; END IF;
  SELECT deleted_at INTO parent_deleted FROM official_usage_sets
    WHERE id=OLD.set_id AND tenant_id=OLD.tenant_id;
  IF parent_deleted IS NULL THEN RAISE EXCEPTION 'official usage live set membership is immutable'; END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER immutable_official_usage_membership BEFORE INSERT OR UPDATE OR DELETE ON official_usage_set_versions
  FOR EACH ROW EXECUTE FUNCTION protect_official_usage_membership();

CREATE FUNCTION protect_official_usage_version_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_deleted timestamptz;
BEGIN
  IF current_user<>'agentcontrol_app' THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'official usage accepted row is immutable'; END IF;
  IF TG_OP='DELETE' THEN
    SELECT deleted_at INTO parent_deleted FROM official_usage_versions WHERE id=OLD.version_id;
    IF parent_deleted IS NULL THEN RAISE EXCEPTION 'official usage live accepted row is immutable'; END IF;
    RETURN OLD;
  END IF;
  SELECT deleted_at INTO parent_deleted FROM official_usage_versions WHERE id=NEW.version_id;
  IF parent_deleted IS NOT NULL THEN RAISE EXCEPTION 'official usage deleted version cannot receive rows'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_official_usage_version_row BEFORE INSERT OR UPDATE OR DELETE ON official_usage_version_rows
  FOR EACH ROW EXECUTE FUNCTION protect_official_usage_version_row();

CREATE FUNCTION protect_official_usage_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE live_kinds integer;
BEGIN
  IF current_user<>'agentcontrol_app' THEN RETURN NEW; END IF;
  IF NEW.tenant_id<>OLD.tenant_id OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at
  THEN RAISE EXCEPTION 'official usage selection revision is invalid'; END IF;
  IF NEW.active_set_id IS NOT NULL THEN
    SELECT count(*) INTO live_kinds FROM official_usage_sets report_set
      JOIN official_usage_set_versions membership ON membership.set_id=report_set.id AND membership.tenant_id=report_set.tenant_id
      JOIN official_usage_versions version ON version.id=membership.version_id AND version.tenant_id=membership.tenant_id AND version.kind=membership.kind
      WHERE report_set.id=NEW.active_set_id AND report_set.tenant_id=NEW.tenant_id AND report_set.complete
        AND report_set.deleted_at IS NULL AND report_set.expires_at>clock_timestamp()
        AND version.deleted_at IS NULL AND version.expires_at>clock_timestamp();
    IF live_kinds<>3 THEN RAISE EXCEPTION 'official usage selection requires three live report kinds'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER valid_official_usage_state BEFORE UPDATE ON official_usage_state
  FOR EACH ROW EXECUTE FUNCTION protect_official_usage_state();
` },
  { version: 15, sql: `
CREATE TABLE official_usage_bundle_receipts (
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  actor_principal_id text NOT NULL CHECK (length(actor_principal_id) BETWEEN 1 AND 256),
  bundle_id uuid NOT NULL,
  bundle_hash text NOT NULL CHECK (bundle_hash ~ '^[a-f0-9]{64}$'),
  expected_active_revision bigint NOT NULL CHECK (expected_active_revision > 0),
  result_set_id uuid NOT NULL,
  result_version_id uuid NOT NULL,
  result_active_revision bigint NOT NULL CHECK (result_active_revision > 0),
  result_complete boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '180 days',
  PRIMARY KEY(tenant_id,bundle_id)
);
CREATE INDEX official_usage_bundle_receipts_expiry ON official_usage_bundle_receipts(expires_at);
CREATE OR REPLACE FUNCTION protect_official_usage_version_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_deleted timestamptz; parent_published boolean;
BEGIN
  IF current_user<>'agentcontrol_app' THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'official usage accepted row is immutable'; END IF;
  IF TG_OP='DELETE' THEN
    SELECT deleted_at INTO parent_deleted FROM official_usage_versions WHERE id=OLD.version_id;
    IF parent_deleted IS NULL THEN RAISE EXCEPTION 'official usage live accepted row is immutable'; END IF;
    RETURN OLD;
  END IF;
  SELECT version.deleted_at,EXISTS(SELECT 1 FROM official_usage_set_versions membership WHERE membership.version_id=version.id)
    INTO parent_deleted,parent_published FROM official_usage_versions version WHERE version.id=NEW.version_id;
  IF parent_deleted IS NOT NULL OR parent_published
  THEN RAISE EXCEPTION 'official usage published or deleted version cannot receive rows'; END IF;
  RETURN NEW;
END $$;
` },
  { version: 16, sql: `
ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_state;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_check CHECK (action IN ('block','unblock','update-availability','update-installation','reassign','view-audit-search','export-audit-search'));
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_state CHECK (
  (action IN ('block','unblock') AND target_blocked_state IS NOT NULL)
  OR (action IN ('update-availability','update-installation','reassign','view-audit-search','export-audit-search') AND target_blocked_state IS NULL));

CREATE TABLE purview_audit_qualifications (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  authorization_principal_id text NOT NULL CHECK (length(authorization_principal_id) BETWEEN 1 AND 256),
  result_principal_id text NOT NULL CHECK (length(result_principal_id) BETWEEN 1 AND 256),
  token_mode text NOT NULL CHECK (token_mode IN ('delegated','application')),
  capability_id text NOT NULL CHECK (capability_id IN ('purview.audit.search.delegated','purview.audit.search.application')),
  filters jsonb NOT NULL CHECK (jsonb_typeof(filters)='object' AND octet_length(filters::text) <= 16384),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  contract_revision text NOT NULL CHECK (length(contract_revision) BETWEEN 1 AND 128),
  permission_revision text NOT NULL CHECK (length(permission_revision) BETWEEN 1 AND 128),
  configuration_revision bigint NOT NULL CHECK (configuration_revision > 0),
  status text NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','running','qualified','failed','inconclusive','expired')),
  approved_by text NOT NULL CHECK (length(approved_by) BETWEEN 1 AND 256),
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempted_at timestamptz,
  finished_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '1 day',
  job_id uuid,
  error_code text CHECK (length(error_code) <= 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((token_mode='delegated' AND capability_id='purview.audit.search.delegated') OR (token_mode='application' AND capability_id='purview.audit.search.application')),
  UNIQUE(tenant_id,id)
);
CREATE INDEX purview_audit_qualifications_scope ON purview_audit_qualifications(tenant_id,result_principal_id,created_at DESC);
CREATE INDEX purview_audit_qualifications_expiry ON purview_audit_qualifications(expires_at);

CREATE TABLE purview_audit_jobs (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  authorization_principal_id text NOT NULL CHECK (length(authorization_principal_id) BETWEEN 1 AND 256),
  result_principal_id text NOT NULL CHECK (length(result_principal_id) BETWEEN 1 AND 256),
  token_mode text NOT NULL CHECK (token_mode IN ('delegated','application')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  display_name text NOT NULL CHECK (display_name ~ '^agent-control-audit:[a-f0-9-]{36}$'),
  filters jsonb NOT NULL CHECK (jsonb_typeof(filters)='object' AND octet_length(filters::text) <= 16384),
  status text NOT NULL DEFAULT 'waiting_authorization' CHECK (status IN ('waiting_authorization','reconciling_create','running','succeeded','failed','cancelled','partial','inconclusive')),
  provider_query_id text CHECK (length(provider_query_id) BETWEEN 1 AND 512),
  provider_status text CHECK (provider_status IN ('notStarted','running','succeeded','failed','cancelled','unknownFutureValue')),
  provider_correlation_id uuid NOT NULL,
  page_count integer NOT NULL DEFAULT 0 CHECK (page_count BETWEEN 0 AND 20),
  provider_row_count integer NOT NULL DEFAULT 0 CHECK (provider_row_count BETWEEN 0 AND 5001),
  stored_row_count integer NOT NULL DEFAULT 0 CHECK (stored_row_count BETWEEN 0 AND 5000),
  byte_count integer NOT NULL DEFAULT 0 CHECK (byte_count BETWEEN 0 AND 10000000),
  unknown_field_count integer NOT NULL DEFAULT 0 CHECK (unknown_field_count BETWEEN 0 AND 1000000),
  page_complete boolean NOT NULL DEFAULT false,
  available_start timestamptz,
  available_end timestamptz,
  unobserved_start timestamptz,
  unobserved_end timestamptz,
  error_code text CHECK (length(error_code) <= 128),
  message text CHECK (length(message) <= 1024),
  qualification_id uuid,
  cancel_requested boolean NOT NULL DEFAULT false,
  remote_work_may_continue boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  deadline_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '48 hours',
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '30 days',
  UNIQUE(tenant_id,result_principal_id,token_mode,idempotency_key),
  UNIQUE(tenant_id,display_name),
  UNIQUE(id,tenant_id,result_principal_id),
  FOREIGN KEY(tenant_id,qualification_id) REFERENCES purview_audit_qualifications(tenant_id,id) ON DELETE SET NULL,
  CHECK ((available_start IS NULL)=(available_end IS NULL)),
  CHECK ((unobserved_start IS NULL)=(unobserved_end IS NULL))
);
ALTER TABLE purview_audit_qualifications ADD CONSTRAINT purview_audit_qualification_job
  FOREIGN KEY(job_id) REFERENCES purview_audit_jobs(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX purview_audit_jobs_scope ON purview_audit_jobs(tenant_id,result_principal_id,created_at DESC,id DESC);
CREATE INDEX purview_audit_jobs_recovery ON purview_audit_jobs(status,deadline_at);
CREATE INDEX purview_audit_jobs_expiry ON purview_audit_jobs(expires_at);
CREATE INDEX purview_audit_jobs_provider ON purview_audit_jobs(tenant_id,provider_query_id) WHERE provider_query_id IS NOT NULL;

CREATE TABLE purview_audit_records (
  job_id uuid NOT NULL,
  tenant_id text NOT NULL,
  result_principal_id text NOT NULL,
  wrapper_id text NOT NULL CHECK (length(wrapper_id) BETWEEN 1 AND 512),
  native_event_id uuid,
  event_time timestamptz NOT NULL,
  audit_log_record_type text NOT NULL CHECK (length(audit_log_record_type) BETWEEN 1 AND 128),
  operation text NOT NULL CHECK (length(operation) BETWEEN 1 AND 256),
  service text NOT NULL CHECK (length(service) BETWEEN 1 AND 128),
  result_status text CHECK (length(result_status) <= 128),
  actor_user_id text CHECK (length(actor_user_id) <= 512),
  actor_user_principal_name text CHECK (length(actor_user_principal_name) <= 512),
  actor_user_type text CHECK (length(actor_user_type) <= 128),
  object_id text CHECK (length(object_id) <= 1024),
  client_ip text CHECK (length(client_ip) <= 128),
  administrative_units jsonb NOT NULL CHECK (jsonb_typeof(administrative_units)='array' AND jsonb_array_length(administrative_units) <= 20 AND octet_length(administrative_units::text) <= 4096),
  correlation_id text CHECK (length(correlation_id) <= 256),
  agent_id text CHECK (length(agent_id) <= 512),
  app_identity text CHECK (length(app_identity) <= 512),
  app_host text CHECK (length(app_host) <= 256),
  bot_id text CHECK (length(bot_id) <= 512),
  environment_id text CHECK (length(environment_id) <= 512),
  bot_component_id text CHECK (length(bot_component_id) <= 512),
  ai_plugin_operation_id text CHECK (length(ai_plugin_operation_id) <= 512),
  messages jsonb NOT NULL CHECK (jsonb_typeof(messages)='array' AND jsonb_array_length(messages) <= 100 AND octet_length(messages::text) <= 65536),
  content_available boolean NOT NULL DEFAULT false CHECK (NOT content_available),
  unknown_field_count integer NOT NULL CHECK (unknown_field_count BETWEEN 0 AND 100000),
  association jsonb CHECK (association IS NULL OR jsonb_typeof(association)='object' AND octet_length(association::text) <= 4096),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(job_id,wrapper_id),
  FOREIGN KEY(job_id,tenant_id,result_principal_id) REFERENCES purview_audit_jobs(id,tenant_id,result_principal_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX purview_audit_records_native_identity ON purview_audit_records(job_id,native_event_id) WHERE native_event_id IS NOT NULL;
CREATE INDEX purview_audit_records_scope ON purview_audit_records(tenant_id,result_principal_id,job_id,event_time DESC,wrapper_id DESC);
` },
  { version: 17, sql: `
ALTER TABLE purview_audit_jobs DROP CONSTRAINT purview_audit_jobs_tenant_id_qualification_id_fkey;
ALTER TABLE purview_audit_qualifications DROP CONSTRAINT purview_audit_qualification_job;

ALTER TABLE purview_audit_qualifications RENAME COLUMN result_principal_id TO result_scope_id;
ALTER TABLE purview_audit_jobs RENAME COLUMN result_principal_id TO result_scope_id;
ALTER TABLE purview_audit_records RENAME COLUMN result_principal_id TO result_scope_id;
ALTER TABLE purview_audit_jobs RENAME COLUMN provider_correlation_id TO local_request_id;
ALTER TABLE purview_audit_jobs RENAME COLUMN available_start TO observed_start;
ALTER TABLE purview_audit_jobs RENAME COLUMN available_end TO observed_end;

ALTER TABLE purview_audit_qualifications
  ADD COLUMN result_scope_kind text NOT NULL DEFAULT 'principal' CHECK (result_scope_kind IN ('principal','application')),
  ADD COLUMN result_scope_configuration_revision bigint,
  ADD COLUMN result_scope_configuration_key bigint GENERATED ALWAYS AS (COALESCE(result_scope_configuration_revision,0)) STORED,
  ADD CONSTRAINT purview_audit_qualification_result_scope CHECK (
    (result_scope_kind='principal' AND result_scope_configuration_revision IS NULL)
    OR (result_scope_kind='application' AND result_scope_configuration_revision>0));
ALTER TABLE purview_audit_qualifications ALTER COLUMN result_scope_kind DROP DEFAULT;

ALTER TABLE purview_audit_jobs
  ADD COLUMN result_scope_kind text NOT NULL DEFAULT 'principal' CHECK (result_scope_kind IN ('principal','application')),
  ADD COLUMN result_scope_configuration_revision bigint,
  ADD COLUMN result_scope_configuration_key bigint GENERATED ALWAYS AS (COALESCE(result_scope_configuration_revision,0)) STORED,
  ADD COLUMN provider_request_id text CHECK (length(provider_request_id) BETWEEN 1 AND 256),
  ADD COLUMN projection_version integer NOT NULL DEFAULT 1 CHECK (projection_version=1),
  ADD COLUMN provider_request_count integer NOT NULL DEFAULT 0 CHECK (provider_request_count BETWEEN 0 AND 64),
  ADD COLUMN activation_count integer NOT NULL DEFAULT 0 CHECK (activation_count BETWEEN 0 AND 12),
  ADD COLUMN execution_version bigint NOT NULL DEFAULT 0 CHECK (execution_version>=0),
  ADD COLUMN execution_owner uuid,
  ADD CONSTRAINT purview_audit_job_result_scope CHECK (
    (result_scope_kind='principal' AND result_scope_configuration_revision IS NULL)
    OR (result_scope_kind='application' AND result_scope_configuration_revision>0));
ALTER TABLE purview_audit_jobs ALTER COLUMN result_scope_kind DROP DEFAULT;

ALTER TABLE purview_audit_records
  ADD COLUMN result_scope_kind text NOT NULL DEFAULT 'principal' CHECK (result_scope_kind IN ('principal','application')),
  ADD COLUMN result_scope_configuration_revision bigint,
  ADD COLUMN result_scope_configuration_key bigint GENERATED ALWAYS AS (COALESCE(result_scope_configuration_revision,0)) STORED,
  ADD COLUMN projection_version integer NOT NULL DEFAULT 1 CHECK (projection_version=1),
  ADD CONSTRAINT purview_audit_record_result_scope CHECK (
    (result_scope_kind='principal' AND result_scope_configuration_revision IS NULL)
    OR (result_scope_kind='application' AND result_scope_configuration_revision>0));
ALTER TABLE purview_audit_records ALTER COLUMN result_scope_kind DROP DEFAULT;

UPDATE purview_audit_qualifications SET filters=filters||jsonb_build_object('operations',CASE filters->>'presetId'
  WHEN 'copilot_interactions' THEN '["CopilotInteraction"]'::jsonb
  WHEN 'copilot_studio_admin' THEN '["BotCreate","BotDelete","BotDeleteCleanup","BotUpdateOperation-BotNameUpdate","BotUpdateOperation-BotAuthUpdate","BotUpdateOperation-BotIconUpdate","BotUpdateOperation-BotPublish","BotUpdateOperation-BotShare","BotAppInsightsUpdate","BotComponentCreate","BotComponentUpdate","BotComponentDelete","BotComponentCollectionCreate","BotComponentCollectionUpdate","BotComponentCollectionDelete","AIPluginOperationCreate","AIPluginOperationUpdate","AIPluginOperationDelete","EnvironmentVariableCreate","EnvironmentVariableUpdate","EnvironmentVariableDelete"]'::jsonb
  ELSE '[]'::jsonb END);
UPDATE purview_audit_jobs SET filters=filters||jsonb_build_object('operations',CASE filters->>'presetId'
  WHEN 'copilot_interactions' THEN '["CopilotInteraction"]'::jsonb
  WHEN 'copilot_studio_admin' THEN '["BotCreate","BotDelete","BotDeleteCleanup","BotUpdateOperation-BotNameUpdate","BotUpdateOperation-BotAuthUpdate","BotUpdateOperation-BotIconUpdate","BotUpdateOperation-BotPublish","BotUpdateOperation-BotShare","BotAppInsightsUpdate","BotComponentCreate","BotComponentUpdate","BotComponentDelete","BotComponentCollectionCreate","BotComponentCollectionUpdate","BotComponentCollectionDelete","AIPluginOperationCreate","AIPluginOperationUpdate","AIPluginOperationDelete","EnvironmentVariableCreate","EnvironmentVariableUpdate","EnvironmentVariableDelete"]'::jsonb
  ELSE '[]'::jsonb END);

CREATE FUNCTION purview_audit_request_hash_v17(
  p_tenant_id text,
  p_authorization_principal_id text,
  p_result_scope_id text,
  p_result_scope_kind text,
  p_result_scope_configuration_revision bigint,
  p_token_mode text,
  p_filters jsonb
) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(
    '{"cloud":"global","tenantId":'||to_json(p_tenant_id)::text||
    ',"authorizationPrincipalId":'||to_json(p_authorization_principal_id)::text||
    ',"resultScope":{"kind":'||to_json(p_result_scope_kind)::text||
    ',"scopeId":'||to_json(p_result_scope_id)::text||
    ',"configurationRevision":'||COALESCE(to_json(p_result_scope_configuration_revision)::text,'null')||
    '},"tokenMode":'||to_json(p_token_mode)::text||
    ',"filters":{"presetId":'||to_json(p_filters->>'presetId')::text||
    ',"operations":'||(SELECT '['||COALESCE(string_agg(to_json(item)::text,',' ORDER BY ordinal),'')||']'
      FROM jsonb_array_elements_text(p_filters->'operations') WITH ORDINALITY AS items(item,ordinal))||
    ',"startDateTime":'||to_json(p_filters->>'startDateTime')::text||
    ',"endDateTime":'||to_json(p_filters->>'endDateTime')::text||
    ',"userPrincipalNames":'||(SELECT '['||COALESCE(string_agg(to_json(item)::text,',' ORDER BY ordinal),'')||']'
      FROM jsonb_array_elements_text(p_filters->'userPrincipalNames') WITH ORDINALITY AS items(item,ordinal))||
    ',"ipAddresses":'||(SELECT '['||COALESCE(string_agg(to_json(item)::text,',' ORDER BY ordinal),'')||']'
      FROM jsonb_array_elements_text(p_filters->'ipAddresses') WITH ORDINALITY AS items(item,ordinal))||
    ',"objectIds":'||(SELECT '['||COALESCE(string_agg(to_json(item)::text,',' ORDER BY ordinal),'')||']'
      FROM jsonb_array_elements_text(p_filters->'objectIds') WITH ORDINALITY AS items(item,ordinal))||
    ',"administrativeUnitIds":'||(SELECT '['||COALESCE(string_agg(to_json(item)::text,',' ORDER BY ordinal),'')||']'
      FROM jsonb_array_elements_text(p_filters->'administrativeUnitIds') WITH ORDINALITY AS items(item,ordinal))||
    '}}','UTF8')),'hex');
$$;
UPDATE purview_audit_qualifications SET request_hash=purview_audit_request_hash_v17(
  tenant_id,authorization_principal_id,result_scope_id,result_scope_kind,result_scope_configuration_revision,token_mode,filters);
UPDATE purview_audit_jobs SET request_hash=purview_audit_request_hash_v17(
  tenant_id,authorization_principal_id,result_scope_id,result_scope_kind,result_scope_configuration_revision,token_mode,filters);
DROP FUNCTION purview_audit_request_hash_v17(text,text,text,text,bigint,text,jsonb);

UPDATE purview_audit_records SET association=NULL;

ALTER TABLE purview_audit_jobs DROP CONSTRAINT purview_audit_jobs_tenant_id_result_principal_id_token_mode_key;
ALTER TABLE purview_audit_jobs ADD CONSTRAINT purview_audit_jobs_result_scope_idempotency_v17
  UNIQUE NULLS NOT DISTINCT(tenant_id,result_scope_kind,result_scope_id,result_scope_configuration_revision,token_mode,idempotency_key);
ALTER TABLE purview_audit_qualifications ADD CONSTRAINT purview_audit_qualification_scope_identity_v17
  UNIQUE(id,tenant_id,result_scope_kind,result_scope_id,result_scope_configuration_key);
ALTER TABLE purview_audit_jobs ADD CONSTRAINT purview_audit_job_scope_identity_v17
  UNIQUE(id,tenant_id,result_scope_kind,result_scope_id,result_scope_configuration_key);
ALTER TABLE purview_audit_jobs ADD CONSTRAINT purview_audit_job_qualification_v17
  FOREIGN KEY(qualification_id,tenant_id,result_scope_kind,result_scope_id,result_scope_configuration_key)
  REFERENCES purview_audit_qualifications(id,tenant_id,result_scope_kind,result_scope_id,result_scope_configuration_key);
ALTER TABLE purview_audit_records ADD CONSTRAINT purview_audit_record_job_v17
  FOREIGN KEY(job_id,tenant_id,result_scope_kind,result_scope_id,result_scope_configuration_key)
  REFERENCES purview_audit_jobs(id,tenant_id,result_scope_kind,result_scope_id,result_scope_configuration_key);
ALTER TABLE purview_audit_qualifications ADD CONSTRAINT purview_audit_qualification_job_v17
  FOREIGN KEY(job_id) REFERENCES purview_audit_jobs(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX purview_audit_jobs_result_scope_v17 ON purview_audit_jobs
  (tenant_id,result_scope_kind,result_scope_id,result_scope_configuration_revision,created_at DESC,id DESC);
CREATE INDEX purview_audit_records_result_scope_v17 ON purview_audit_records
  (tenant_id,result_scope_kind,result_scope_id,result_scope_configuration_revision,job_id,event_time DESC,wrapper_id DESC);
` },
  { version: 18, sql: `
ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_state;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_check CHECK (action IN ('block','unblock','update-availability','update-installation','reassign','view-audit-search','export-audit-search','view-hunting','export-hunting'));
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_state CHECK (
  (action IN ('block','unblock') AND target_blocked_state IS NOT NULL)
  OR (action IN ('update-availability','update-installation','reassign','view-audit-search','export-audit-search','view-hunting','export-hunting') AND target_blocked_state IS NULL));

CREATE TABLE defender_hunting_jobs (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  authorization_principal_id text NOT NULL CHECK (length(authorization_principal_id) BETWEEN 1 AND 256),
  result_scope_id text NOT NULL CHECK (length(result_scope_id) BETWEEN 1 AND 256),
  result_scope_kind text NOT NULL CHECK (result_scope_kind IN ('principal','application')),
  result_scope_configuration_revision bigint,
  result_scope_configuration_key bigint GENERATED ALWAYS AS (COALESCE(result_scope_configuration_revision,0)) STORED,
  token_mode text NOT NULL CHECK (token_mode IN ('delegated','application')),
  template_id text NOT NULL CHECK (template_id IN ('agents_inventory','agent_activity','agent_tools')),
  query_version integer NOT NULL DEFAULT 1 CHECK (query_version=1),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[a-zA-Z0-9_-]{1,128}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  filters jsonb NOT NULL CHECK (jsonb_typeof(filters)='object' AND octet_length(filters::text)<=16384),
  status text NOT NULL DEFAULT 'waiting_authorization' CHECK (status IN ('waiting_authorization','running','succeeded','partial','failed','cancelled','inconclusive')),
  local_request_id uuid NOT NULL,
  provider_request_id text CHECK (length(provider_request_id) BETWEEN 1 AND 256),
  provider_request_count integer NOT NULL DEFAULT 0 CHECK (provider_request_count BETWEEN 0 AND 12),
  activation_count integer NOT NULL DEFAULT 0 CHECK (activation_count BETWEEN 0 AND 4),
  execution_version bigint NOT NULL DEFAULT 0 CHECK (execution_version>=0),
  execution_owner uuid,
  provider_row_count integer NOT NULL DEFAULT 0 CHECK (provider_row_count BETWEEN 0 AND 201),
  stored_row_count integer NOT NULL DEFAULT 0 CHECK (stored_row_count BETWEEN 0 AND 200),
  byte_count integer NOT NULL DEFAULT 0 CHECK (byte_count BETWEEN 0 AND 2000000),
  result_complete boolean NOT NULL DEFAULT false,
  no_data boolean NOT NULL DEFAULT false,
  partial_reason text CHECK (partial_reason='hunting_row_limit'),
  observed_start timestamptz,
  observed_end timestamptz,
  unobserved_start timestamptz,
  unobserved_end timestamptz,
  is_qualification boolean NOT NULL DEFAULT false,
  capability_id text CHECK (capability_id IN ('defender.hunting.delegated','defender.hunting.application')),
  contract_revision text CHECK (contract_revision ~ '^[a-f0-9]{64}$'),
  permission_revision text CHECK (permission_revision ~ '^[a-f0-9]{64}$'),
  qualification_configuration_revision bigint CHECK (qualification_configuration_revision>0),
  approved_by text CHECK (length(approved_by) BETWEEN 1 AND 256),
  error_code text CHECK (length(error_code)<=128),
  message text CHECK (length(message)<=1024),
  cancel_requested boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  deadline_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '15 minutes',
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '30 days',
  CHECK ((result_scope_kind='principal' AND result_scope_configuration_revision IS NULL AND token_mode='delegated')
    OR (result_scope_kind='application' AND result_scope_configuration_revision>0 AND token_mode='application')),
  CHECK ((observed_start IS NULL)=(observed_end IS NULL)),
  CHECK ((unobserved_start IS NULL)=(unobserved_end IS NULL)),
  CHECK ((is_qualification AND capability_id IS NOT NULL AND contract_revision IS NOT NULL AND permission_revision IS NOT NULL
    AND qualification_configuration_revision IS NOT NULL AND approved_by IS NOT NULL)
    OR (NOT is_qualification AND capability_id IS NULL AND contract_revision IS NULL AND permission_revision IS NULL
      AND qualification_configuration_revision IS NULL AND approved_by IS NULL)),
  CHECK (capability_id IS NULL OR (token_mode='delegated' AND capability_id='defender.hunting.delegated')
    OR (token_mode='application' AND capability_id='defender.hunting.application')),
  CHECK ((status IN ('succeeded','partial') AND result_complete=(status='succeeded') AND no_data=(stored_row_count=0 AND status='succeeded'))
    OR status NOT IN ('succeeded','partial')),
  UNIQUE NULLS NOT DISTINCT(tenant_id,result_scope_kind,result_scope_id,result_scope_configuration_revision,token_mode,idempotency_key),
  UNIQUE(id,tenant_id,result_scope_kind,result_scope_id,result_scope_configuration_key)
);
CREATE INDEX defender_hunting_jobs_scope_v18 ON defender_hunting_jobs
  (tenant_id,result_scope_kind,result_scope_id,result_scope_configuration_revision,created_at DESC,id DESC);
CREATE INDEX defender_hunting_jobs_recovery_v18 ON defender_hunting_jobs(status,deadline_at);
CREATE INDEX defender_hunting_jobs_expiry_v18 ON defender_hunting_jobs(expires_at);

CREATE TABLE defender_hunting_snapshots (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL UNIQUE,
  tenant_id text NOT NULL,
  result_scope_id text NOT NULL,
  result_scope_kind text NOT NULL CHECK (result_scope_kind IN ('principal','application')),
  result_scope_configuration_revision bigint,
  result_scope_configuration_key bigint GENERATED ALWAYS AS (COALESCE(result_scope_configuration_revision,0)) STORED,
  template_id text NOT NULL CHECK (template_id IN ('agents_inventory','agent_activity','agent_tools')),
  source_table text NOT NULL CHECK (source_table IN ('AgentsInfo','CloudAppEvents')),
  query_version integer NOT NULL DEFAULT 1 CHECK (query_version=1),
  filters jsonb NOT NULL CHECK (jsonb_typeof(filters)='object' AND octet_length(filters::text)<=16384),
  requested_start timestamptz NOT NULL,
  requested_end timestamptz NOT NULL,
  observed_start timestamptz,
  observed_end timestamptz,
  unobserved_start timestamptz,
  unobserved_end timestamptz,
  observation_time timestamptz NOT NULL DEFAULT clock_timestamp(),
  result_complete boolean NOT NULL,
  no_data boolean NOT NULL,
  partial_reason text CHECK (partial_reason='hunting_row_limit'),
  provider_row_count integer NOT NULL CHECK (provider_row_count BETWEEN 0 AND 201),
  stored_row_count integer NOT NULL CHECK (stored_row_count BETWEEN 0 AND 200),
  byte_count integer NOT NULL CHECK (byte_count BETWEEN 0 AND 2000000),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '30 days',
  CHECK (requested_end>requested_start),
  CHECK ((observed_start IS NULL)=(observed_end IS NULL)),
  CHECK ((unobserved_start IS NULL)=(unobserved_end IS NULL)),
  CHECK (no_data=(result_complete AND stored_row_count=0)),
  CHECK ((result_complete AND partial_reason IS NULL AND unobserved_start IS NULL) OR (NOT result_complete AND partial_reason IS NOT NULL AND unobserved_start IS NOT NULL)),
  UNIQUE(id,tenant_id,result_scope_kind,result_scope_id,result_scope_configuration_key),
  FOREIGN KEY(job_id,tenant_id,result_scope_kind,result_scope_id,result_scope_configuration_key)
    REFERENCES defender_hunting_jobs(id,tenant_id,result_scope_kind,result_scope_id,result_scope_configuration_key) ON DELETE CASCADE
);
CREATE INDEX defender_hunting_snapshots_scope_v18 ON defender_hunting_snapshots
  (tenant_id,result_scope_kind,result_scope_id,result_scope_configuration_revision,observation_time DESC,id DESC);
CREATE INDEX defender_hunting_snapshots_expiry_v18 ON defender_hunting_snapshots(expires_at);

CREATE TABLE defender_hunting_rows (
  snapshot_id uuid NOT NULL,
  row_ordinal integer NOT NULL CHECK (row_ordinal BETWEEN 0 AND 199),
  tenant_id text NOT NULL,
  result_scope_id text NOT NULL,
  result_scope_kind text NOT NULL CHECK (result_scope_kind IN ('principal','application')),
  result_scope_configuration_revision bigint,
  result_scope_configuration_key bigint GENERATED ALWAYS AS (COALESCE(result_scope_configuration_revision,0)) STORED,
  source_table text NOT NULL CHECK (source_table IN ('AgentsInfo','CloudAppEvents')),
  projection_version integer NOT NULL DEFAULT 1 CHECK (projection_version=1),
  row_data jsonb NOT NULL CHECK (jsonb_typeof(row_data)='object' AND octet_length(row_data::text)<=16384),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(snapshot_id,row_ordinal),
  CHECK (NOT (row_data ?| ARRAY['RawEventData','rawEventData','Instructions','instructions','Memory','memory','InputMessages','inputMessages','OutputMessages','outputMessages','ToolArguments','toolArguments','ToolResult','toolResult'])),
  CHECK (row_data->>'contentAvailable' IS NULL OR row_data->>'contentAvailable'='false'),
  FOREIGN KEY(snapshot_id,tenant_id,result_scope_kind,result_scope_id,result_scope_configuration_key)
    REFERENCES defender_hunting_snapshots(id,tenant_id,result_scope_kind,result_scope_id,result_scope_configuration_key) ON DELETE CASCADE
);
CREATE INDEX defender_hunting_rows_scope_v18 ON defender_hunting_rows
  (tenant_id,result_scope_kind,result_scope_id,result_scope_configuration_revision,snapshot_id,row_ordinal);
` },
  { version: 19, sql: `
ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_state;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_check CHECK (action IN (
  'block','unblock','update-availability','update-installation','reassign','view-audit-search','export-audit-search',
  'view-hunting','export-hunting','approve-hunting','qualify-hunting','submit-hunting','query-hunting'));
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_state CHECK (
  (action IN ('block','unblock') AND target_blocked_state IS NOT NULL)
  OR (action IN ('update-availability','update-installation','reassign','view-audit-search','export-audit-search',
    'view-hunting','export-hunting','approve-hunting','qualify-hunting','submit-hunting','query-hunting') AND target_blocked_state IS NULL));

ALTER TABLE defender_hunting_jobs ADD COLUMN target_scope_hash text CHECK (target_scope_hash ~ '^[a-f0-9]{64}$');
ALTER TABLE defender_hunting_jobs DROP CONSTRAINT defender_hunting_jobs_query_version_check;
ALTER TABLE defender_hunting_jobs ALTER COLUMN query_version SET DEFAULT 2;
ALTER TABLE defender_hunting_jobs ADD CONSTRAINT defender_hunting_jobs_query_version_v19 CHECK (query_version IN (1,2));
ALTER TABLE defender_hunting_snapshots DROP CONSTRAINT defender_hunting_snapshots_query_version_check;
ALTER TABLE defender_hunting_snapshots ALTER COLUMN query_version SET DEFAULT 2;
ALTER TABLE defender_hunting_snapshots ADD CONSTRAINT defender_hunting_snapshots_query_version_v19 CHECK (query_version IN (1,2));

UPDATE defender_hunting_rows SET row_data=(row_data-'projectionVersion') || '{"projectionVersion":2}'::jsonb ||
  CASE WHEN source_table='AgentsInfo' THEN jsonb_build_object('detailStates',jsonb_build_object(
    'owners',CASE WHEN row_data->'ownerCount'='null'::jsonb THEN 'not_supplied' ELSE 'present_unqualified_shape' END,
    'sharing',CASE WHEN row_data->'sharedWithCount'='null'::jsonb THEN 'not_supplied' ELSE 'present_unqualified_shape' END,
    'permissions',CASE WHEN row_data->'permissionMetadataKeyCount'='null'::jsonb THEN 'not_supplied' ELSE 'present_unqualified_shape' END,
    'authentication',CASE WHEN row_data->'authenticationMetadataKeyCount'='null'::jsonb THEN 'not_supplied' ELSE 'present_unqualified_shape' END,
    'risk','not_exposed'))
  ELSE (row_data-'actorUserKey'-'actorUserId') || jsonb_build_object(
    'platformAgentType',NULL,'conversationThreadId',NULL,
    'humanActorUserObjectId',CASE WHEN row_data->>'actionType'='InvokeAgent' THEN row_data->'actorUserKey' ELSE 'null'::jsonb END,
    'humanActorUserPrincipalName',CASE WHEN row_data->>'actionType'='InvokeAgent' THEN row_data->'actorUserId' ELSE 'null'::jsonb END,
    'agentUserObjectId',CASE WHEN row_data->>'actionType'<>'InvokeAgent' THEN row_data->'actorUserKey' ELSE 'null'::jsonb END,
    'agentUserPrincipalName',CASE WHEN row_data->>'actionType'<>'InvokeAgent' THEN row_data->'actorUserId' ELSE 'null'::jsonb END,
    'targetAgentUserObjectId',NULL,'durationMilliseconds',NULL,
    'outcome',CASE WHEN NULLIF(row_data->>'errorType','') IS NULL THEN 'unknown' ELSE 'error' END,
    'spanRole',CASE WHEN row_data->>'operation'='invoke_agent' AND row_data->'parentSpanId'='null'::jsonb THEN 'root_invoke_agent'
      WHEN NULLIF(row_data->>'parentSpanId','') IS NOT NULL THEN 'child' ELSE 'unresolved' END,
    'establishesAdminCenterRun',row_data->>'operation'='invoke_agent' AND row_data->'parentSpanId'='null'::jsonb,
    'fieldStates',jsonb_build_object('conversationId','unavailable','conversationThreadId','unavailable','channelName','unavailable',
      'humanActorUserObjectId','unavailable','agentUserObjectId','unavailable','targetAgentUserObjectId','unavailable',
      'completionTime','unavailable','errorType','unavailable','platformAgentId','unavailable','platformAgentType','unavailable')) END;
ALTER TABLE defender_hunting_rows DROP CONSTRAINT defender_hunting_rows_projection_version_check;
ALTER TABLE defender_hunting_rows ALTER COLUMN projection_version SET DEFAULT 2;
UPDATE defender_hunting_rows SET projection_version=2;
ALTER TABLE defender_hunting_rows ADD CONSTRAINT defender_hunting_rows_projection_version_v19 CHECK (projection_version=2);

CREATE TABLE defender_hunting_qualification_evidence (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  authorization_principal_id text NOT NULL CHECK (length(authorization_principal_id) BETWEEN 1 AND 256),
  result_scope_id text NOT NULL CHECK (length(result_scope_id) BETWEEN 1 AND 256),
  result_scope_kind text NOT NULL CHECK (result_scope_kind IN ('principal','application')),
  result_scope_configuration_revision bigint,
  token_mode text NOT NULL CHECK (token_mode IN ('delegated','application')),
  capability_id text NOT NULL CHECK (capability_id IN ('defender.hunting.delegated','defender.hunting.application')),
  template_id text NOT NULL CHECK (template_id IN ('agents_inventory','agent_activity','agent_tools')),
  target_scope_hash text NOT NULL CHECK (target_scope_hash ~ '^[a-f0-9]{64}$'),
  approved_scope jsonb NOT NULL CHECK (jsonb_typeof(approved_scope)='object' AND octet_length(approved_scope::text)<=8192),
  contract_revision text NOT NULL CHECK (contract_revision ~ '^[a-f0-9]{64}$'),
  permission_revision text NOT NULL CHECK (permission_revision ~ '^[a-f0-9]{64}$'),
  configuration_revision bigint NOT NULL CHECK (configuration_revision>0),
  approved_by text NOT NULL CHECK (length(approved_by) BETWEEN 1 AND 256),
  qualified_job_id uuid NOT NULL UNIQUE REFERENCES defender_hunting_jobs(id) ON DELETE CASCADE,
  provider_request_id text CHECK (length(provider_request_id) BETWEEN 1 AND 256),
  qualified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
  CHECK ((result_scope_kind='principal' AND result_scope_configuration_revision IS NULL AND token_mode='delegated'
      AND capability_id='defender.hunting.delegated' AND result_scope_id=authorization_principal_id)
    OR (result_scope_kind='application' AND result_scope_configuration_revision>0 AND token_mode='application'
      AND capability_id='defender.hunting.application'))
);
CREATE INDEX defender_hunting_qualification_scope_v19 ON defender_hunting_qualification_evidence
  (tenant_id,result_scope_kind,result_scope_id,result_scope_configuration_revision,template_id,target_scope_hash,expires_at);
` },
  { version: 20, sql: `
ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_state;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_check CHECK (action IN (
  'block','unblock','update-availability','update-installation','reassign','view-audit-search','export-audit-search',
  'view-hunting','export-hunting','approve-hunting','qualify-hunting','submit-hunting','query-hunting','cancel-hunting','delete-hunting'));
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_state CHECK (
  (action IN ('block','unblock') AND target_blocked_state IS NOT NULL)
  OR (action IN ('update-availability','update-installation','reassign','view-audit-search','export-audit-search',
    'view-hunting','export-hunting','approve-hunting','qualify-hunting','submit-hunting','query-hunting','cancel-hunting','delete-hunting')
    AND target_blocked_state IS NULL));
` },
  { version: 21, sql: `
ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_state;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_check CHECK (action IN (
  'block','unblock','update-availability','update-installation','reassign','view-audit-search','export-audit-search',
  'view-hunting','export-hunting','approve-hunting','qualify-hunting','submit-hunting','query-hunting','cancel-hunting','delete-hunting',
  'revoke-hunting-scope'));
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_state CHECK (
  (action IN ('block','unblock') AND target_blocked_state IS NOT NULL)
  OR (action IN ('update-availability','update-installation','reassign','view-audit-search','export-audit-search',
    'view-hunting','export-hunting','approve-hunting','qualify-hunting','submit-hunting','query-hunting','cancel-hunting','delete-hunting',
    'revoke-hunting-scope') AND target_blocked_state IS NULL));

ALTER TABLE defender_hunting_jobs DROP CONSTRAINT defender_hunting_jobs_query_version_v19;
ALTER TABLE defender_hunting_jobs ALTER COLUMN query_version SET DEFAULT 3;
ALTER TABLE defender_hunting_jobs ADD CONSTRAINT defender_hunting_jobs_query_version_v21 CHECK (query_version IN (1,2,3));
ALTER TABLE defender_hunting_snapshots DROP CONSTRAINT defender_hunting_snapshots_query_version_v19;
ALTER TABLE defender_hunting_snapshots ALTER COLUMN query_version SET DEFAULT 3;
ALTER TABLE defender_hunting_snapshots ADD CONSTRAINT defender_hunting_snapshots_query_version_v21 CHECK (query_version IN (1,2,3));
ALTER TABLE defender_hunting_rows DROP CONSTRAINT defender_hunting_rows_projection_version_v19;
ALTER TABLE defender_hunting_rows ALTER COLUMN projection_version SET DEFAULT 3;
ALTER TABLE defender_hunting_rows ADD CONSTRAINT defender_hunting_rows_projection_version_v21 CHECK (projection_version IN (2,3));

CREATE TABLE defender_hunting_retained_scopes (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  authorization_principal_id text NOT NULL CHECK (length(authorization_principal_id) BETWEEN 1 AND 256),
  result_scope_id text NOT NULL CHECK (length(result_scope_id) BETWEEN 1 AND 256),
  result_scope_kind text NOT NULL CHECK (result_scope_kind IN ('principal','application')),
  result_scope_configuration_revision bigint,
  result_scope_configuration_key bigint GENERATED ALWAYS AS (COALESCE(result_scope_configuration_revision,0)) STORED,
  token_mode text NOT NULL CHECK (token_mode IN ('delegated','application')),
  capability_id text NOT NULL CHECK (capability_id IN ('defender.hunting.delegated','defender.hunting.application')),
  template_id text NOT NULL CHECK (template_id IN ('agents_inventory','agent_activity','agent_tools')),
  target_scope_hash text NOT NULL CHECK (target_scope_hash ~ '^[a-f0-9]{64}$'),
  approved_scope jsonb NOT NULL CHECK (jsonb_typeof(approved_scope)='object' AND octet_length(approved_scope::text)<=8192),
  query_version integer NOT NULL CHECK (query_version=3),
  contract_revision text NOT NULL CHECK (contract_revision ~ '^[a-f0-9]{64}$'),
  permission_revision text NOT NULL CHECK (permission_revision ~ '^[a-f0-9]{64}$'),
  configuration_revision bigint NOT NULL CHECK (configuration_revision>0),
  approved_by text NOT NULL CHECK (length(approved_by) BETWEEN 1 AND 256),
  source_qualification_job_id uuid NOT NULL,
  approved_at timestamptz NOT NULL,
  qualified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by text CHECK (length(revoked_by) BETWEEN 1 AND 256),
  CHECK (qualified_at>=approved_at AND expires_at=approved_at+interval '30 days'),
  CHECK ((revoked_at IS NULL AND revoked_by IS NULL) OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL)),
  CHECK ((result_scope_kind='principal' AND result_scope_configuration_revision IS NULL AND token_mode='delegated'
      AND capability_id='defender.hunting.delegated' AND result_scope_id=authorization_principal_id)
    OR (result_scope_kind='application' AND result_scope_configuration_revision>0 AND token_mode='application'
      AND capability_id='defender.hunting.application'))
);
CREATE UNIQUE INDEX defender_hunting_retained_scope_active_v21 ON defender_hunting_retained_scopes
  (tenant_id,authorization_principal_id,result_scope_kind,result_scope_id,result_scope_configuration_key,token_mode,
    capability_id,template_id,target_scope_hash,query_version,contract_revision,permission_revision,configuration_revision)
  WHERE revoked_at IS NULL;
CREATE INDEX defender_hunting_retained_scope_visibility_v21 ON defender_hunting_retained_scopes
  (tenant_id,result_scope_kind,result_scope_id,result_scope_configuration_revision,expires_at,id);

ALTER TABLE defender_hunting_jobs ADD COLUMN retained_scope_id uuid
  REFERENCES defender_hunting_retained_scopes(id) ON DELETE RESTRICT;
CREATE INDEX defender_hunting_jobs_retained_scope_v21 ON defender_hunting_jobs(retained_scope_id) WHERE retained_scope_id IS NOT NULL;
` },
  { version: 22, sql: `
CREATE TABLE copilot_quarantine_status_observations (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  principal_id text NOT NULL CHECK (length(principal_id) BETWEEN 1 AND 256),
  resource_native_id text NOT NULL CHECK (length(resource_native_id) BETWEEN 1 AND 512),
  environment_id text NOT NULL CHECK (length(environment_id) BETWEEN 1 AND 512),
  bot_id text NOT NULL CHECK (length(bot_id) BETWEEN 1 AND 512),
  is_bot_quarantined boolean NOT NULL,
  provider_updated_at text NOT NULL CHECK (provider_updated_at ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,7})?Z$'),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  correlation_id uuid NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '30 days'
);
CREATE INDEX copilot_quarantine_status_target_v22 ON copilot_quarantine_status_observations
  (tenant_id,principal_id,environment_id,bot_id,observed_at DESC,id DESC);
CREATE INDEX copilot_quarantine_status_expiry_v22 ON copilot_quarantine_status_observations(expires_at);

CREATE TABLE copilot_quarantine_jobs (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  principal_id text NOT NULL CHECK (length(principal_id) BETWEEN 1 AND 256),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[a-zA-Z0-9_-]{1,128}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  action text NOT NULL CHECK (action IN ('quarantine','unquarantine')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','waiting_authorization','succeeded','failed','cancelled','partial','inconclusive')),
  confirmation_hash text NOT NULL CHECK (confirmation_hash ~ '^[a-f0-9]{64}$'),
  confirmation_summary jsonb NOT NULL CHECK (jsonb_typeof(confirmation_summary)='object' AND octet_length(confirmation_summary::text)<=65536),
  actor_name text NOT NULL CHECK (length(actor_name) BETWEEN 1 AND 256),
  actor_username text NOT NULL CHECK (length(actor_username) BETWEEN 1 AND 256),
  request_path text NOT NULL CHECK (length(request_path) BETWEEN 1 AND 1024),
  contract_revision text NOT NULL CHECK (contract_revision ~ '^[a-f0-9]{64}$'),
  permission_revision text NOT NULL CHECK (permission_revision ~ '^[a-f0-9]{64}$'),
  configuration_revision bigint NOT NULL CHECK (configuration_revision>0),
  is_canary boolean NOT NULL DEFAULT false,
  canary_approval_id uuid,
  cancel_requested boolean NOT NULL DEFAULT false,
  lease_owner uuid,
  lease_version bigint NOT NULL DEFAULT 0 CHECK (lease_version>=0),
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deadline_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '30 minutes',
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '7 days',
  UNIQUE(tenant_id,principal_id,idempotency_key),
  CHECK ((is_canary AND canary_approval_id IS NOT NULL) OR (NOT is_canary AND canary_approval_id IS NULL))
);
CREATE INDEX copilot_quarantine_jobs_scope_v22 ON copilot_quarantine_jobs(tenant_id,principal_id,created_at DESC,id DESC);
CREATE INDEX copilot_quarantine_jobs_recovery_v22 ON copilot_quarantine_jobs(status,deadline_at,lease_until);
CREATE INDEX copilot_quarantine_jobs_expiry_v22 ON copilot_quarantine_jobs(expires_at);

CREATE TABLE copilot_quarantine_job_items (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES copilot_quarantine_jobs(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 24),
  resource_native_id text NOT NULL CHECK (length(resource_native_id) BETWEEN 1 AND 512),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 512),
  snapshot_id uuid NOT NULL,
  inventory_observed_at timestamptz NOT NULL,
  environment_id text NOT NULL CHECK (length(environment_id) BETWEEN 1 AND 512),
  bot_id text NOT NULL CHECK (length(bot_id) BETWEEN 1 AND 512),
  prestate boolean NOT NULL,
  prestate_provider_updated_at text NOT NULL CHECK (prestate_provider_updated_at ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,7})?Z$'),
  requested_state boolean NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled','inconclusive','skipped')),
  sent_at timestamptz,
  correlation_id uuid,
  observed_state boolean,
  observed_provider_updated_at text CHECK (observed_provider_updated_at IS NULL OR observed_provider_updated_at ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,7})?Z$'),
  observed_at timestamptz,
  readback_count integer NOT NULL DEFAULT 0 CHECK (readback_count BETWEEN 0 AND 20),
  reconciliation_status text NOT NULL DEFAULT 'not_required' CHECK (reconciliation_status IN ('not_required','required','verified_applied','verified_not_applied','conflict')),
  reconciled_at timestamptz,
  error_code text CHECK (length(error_code)<=128),
  message text CHECK (length(message)<=1024),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(job_id,ordinal),
  UNIQUE(job_id,environment_id,bot_id),
  CHECK ((observed_state IS NULL AND observed_provider_updated_at IS NULL AND observed_at IS NULL)
    OR (observed_state IS NOT NULL AND observed_provider_updated_at IS NOT NULL AND observed_at IS NOT NULL)),
  CHECK ((reconciliation_status IN ('not_required','required') AND reconciled_at IS NULL)
    OR (reconciliation_status IN ('verified_applied','verified_not_applied','conflict') AND reconciled_at IS NOT NULL))
);
CREATE INDEX copilot_quarantine_items_unresolved_v22 ON copilot_quarantine_job_items(environment_id,bot_id,status,reconciliation_status);

CREATE TABLE copilot_quarantine_attempts (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES copilot_quarantine_jobs(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES copilot_quarantine_job_items(id) ON DELETE CASCADE,
  lease_owner uuid NOT NULL,
  lease_version bigint NOT NULL,
  correlation_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sent_at timestamptz,
  finished_at timestamptz,
  outcome text CHECK (outcome IN ('succeeded','failed','cancelled','inconclusive','skipped')),
  UNIQUE(item_id,lease_version)
);

CREATE TABLE copilot_quarantine_audit (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  principal_id text NOT NULL CHECK (length(principal_id) BETWEEN 1 AND 256),
  actor_username text NOT NULL CHECK (length(actor_username) BETWEEN 1 AND 256),
  actor_name text NOT NULL CHECK (length(actor_name) BETWEEN 1 AND 256),
  job_id uuid NOT NULL,
  item_id uuid,
  correlation_id uuid,
  action text NOT NULL CHECK (action IN ('quarantine','unquarantine','reconcile')),
  phase text NOT NULL CHECK (phase IN ('requested','started','sent','succeeded','skipped','failed','inconclusive','reconciled')),
  resource_native_id text NOT NULL CHECK (length(resource_native_id) BETWEEN 1 AND 512),
  environment_id text NOT NULL CHECK (length(environment_id) BETWEEN 1 AND 512),
  bot_id text NOT NULL CHECK (length(bot_id) BETWEEN 1 AND 512),
  requested_state boolean NOT NULL,
  observed_state boolean,
  observed_provider_updated_at text CHECK (observed_provider_updated_at IS NULL OR observed_provider_updated_at ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,7})?Z$'),
  error_code text CHECK (length(error_code)<=128),
  message text CHECK (length(message)<=1024),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '90 days',
  CHECK ((observed_state IS NULL)=(observed_provider_updated_at IS NULL))
);
CREATE INDEX copilot_quarantine_audit_scope_v22 ON copilot_quarantine_audit(tenant_id,principal_id,observed_at DESC,id DESC);
CREATE INDEX copilot_quarantine_audit_expiry_v22 ON copilot_quarantine_audit(expires_at);

CREATE TABLE copilot_quarantine_canary_approvals (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  approved_by_principal_id text NOT NULL CHECK (length(approved_by_principal_id) BETWEEN 1 AND 256),
  resource_native_id text NOT NULL CHECK (length(resource_native_id) BETWEEN 1 AND 512),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 512),
  snapshot_id uuid NOT NULL,
  inventory_observed_at timestamptz NOT NULL,
  environment_id text NOT NULL CHECK (length(environment_id) BETWEEN 1 AND 512),
  bot_id text NOT NULL CHECK (length(bot_id) BETWEEN 1 AND 512),
  action text NOT NULL CHECK (action IN ('quarantine','unquarantine')),
  prestate boolean NOT NULL,
  prestate_provider_updated_at text CHECK (prestate_provider_updated_at IS NULL OR prestate_provider_updated_at ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,7})?Z$'),
  poststate boolean NOT NULL,
  contract_revision text NOT NULL CHECK (contract_revision ~ '^[a-f0-9]{64}$'),
  permission_revision text NOT NULL CHECK (permission_revision ~ '^[a-f0-9]{64}$'),
  configuration_revision bigint NOT NULL CHECK (configuration_revision>0),
  auth_mode text NOT NULL CHECK (auth_mode='delegated'),
  status text NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','claimed','qualified','failed','inconclusive','conflict','expired')),
  paired_approval_id uuid,
  actor_principal_id text CHECK (actor_principal_id IS NULL OR length(actor_principal_id) BETWEEN 1 AND 256),
  job_id uuid,
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempted_at timestamptz,
  finished_at timestamptz,
  approval_expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '30 minutes',
  evidence_expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '30 days',
  error_code text CHECK (length(error_code)<=128),
  CHECK (prestate<>poststate),
  CHECK ((status='approved' AND paired_approval_id IS NULL AND actor_principal_id IS NULL AND job_id IS NULL AND attempted_at IS NULL)
    OR status='expired'
    OR (status NOT IN ('approved','expired') AND paired_approval_id IS NOT NULL AND actor_principal_id IS NOT NULL AND attempted_at IS NOT NULL))
);
CREATE INDEX copilot_quarantine_canary_scope_v22 ON copilot_quarantine_canary_approvals(tenant_id,status,approval_expires_at,id);

CREATE TABLE copilot_quarantine_qualifications (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  target_environment_id text NOT NULL CHECK (length(target_environment_id) BETWEEN 1 AND 512),
  target_bot_id text NOT NULL CHECK (length(target_bot_id) BETWEEN 1 AND 512),
  original_approval_id uuid NOT NULL,
  restoration_approval_id uuid NOT NULL,
  original_job_id uuid NOT NULL,
  restoration_job_id uuid NOT NULL,
  contract_revision text NOT NULL CHECK (contract_revision ~ '^[a-f0-9]{64}$'),
  permission_revision text NOT NULL CHECK (permission_revision ~ '^[a-f0-9]{64}$'),
  configuration_revision bigint NOT NULL CHECK (configuration_revision>0),
  auth_mode text NOT NULL CHECK (auth_mode='delegated'),
  qualified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '30 days',
  CHECK (original_approval_id<>restoration_approval_id),
  CHECK (original_job_id<>restoration_job_id)
);
CREATE INDEX copilot_quarantine_qualifications_expiry_v22 ON copilot_quarantine_qualifications(expires_at);

CREATE FUNCTION protect_copilot_quarantine_job_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.tenant_id,NEW.principal_id,NEW.idempotency_key,NEW.request_hash,NEW.action,NEW.confirmation_hash,
      NEW.confirmation_summary,NEW.actor_name,NEW.actor_username,NEW.request_path,NEW.contract_revision,
      NEW.permission_revision,NEW.configuration_revision,NEW.is_canary,NEW.canary_approval_id,NEW.created_at,NEW.deadline_at,NEW.expires_at)
    IS DISTINCT FROM
     (OLD.id,OLD.tenant_id,OLD.principal_id,OLD.idempotency_key,OLD.request_hash,OLD.action,OLD.confirmation_hash,
      OLD.confirmation_summary,OLD.actor_name,OLD.actor_username,OLD.request_path,OLD.contract_revision,
      OLD.permission_revision,OLD.configuration_revision,OLD.is_canary,OLD.canary_approval_id,OLD.created_at,OLD.deadline_at,OLD.expires_at)
  THEN RAISE EXCEPTION 'quarantine job intent is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_copilot_quarantine_job BEFORE UPDATE ON copilot_quarantine_jobs
  FOR EACH ROW EXECUTE FUNCTION protect_copilot_quarantine_job_intent();

CREATE FUNCTION protect_copilot_quarantine_item_target() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.job_id,NEW.ordinal,NEW.resource_native_id,NEW.display_name,NEW.snapshot_id,NEW.inventory_observed_at,
      NEW.environment_id,NEW.bot_id,NEW.prestate,NEW.prestate_provider_updated_at,NEW.requested_state)
    IS DISTINCT FROM
     (OLD.id,OLD.job_id,OLD.ordinal,OLD.resource_native_id,OLD.display_name,OLD.snapshot_id,OLD.inventory_observed_at,
      OLD.environment_id,OLD.bot_id,OLD.prestate,OLD.prestate_provider_updated_at,OLD.requested_state)
  THEN RAISE EXCEPTION 'quarantine item target is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_copilot_quarantine_item BEFORE UPDATE ON copilot_quarantine_job_items
  FOR EACH ROW EXECUTE FUNCTION protect_copilot_quarantine_item_target();
` },
  { version: 23, sql: `
ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_state;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_check CHECK (action IN (
  'block','unblock','update-availability','update-installation','reassign','view-audit-search','export-audit-search',
  'view-hunting','export-hunting','approve-hunting','qualify-hunting','submit-hunting','query-hunting','cancel-hunting','delete-hunting',
  'revoke-hunting-scope','export-package-inventory','export-power-platform-inventory'));
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_state CHECK (
  (action IN ('block','unblock') AND target_blocked_state IS NOT NULL)
  OR (action IN ('update-availability','update-installation','reassign','view-audit-search','export-audit-search',
    'view-hunting','export-hunting','approve-hunting','qualify-hunting','submit-hunting','query-hunting','cancel-hunting','delete-hunting',
    'revoke-hunting-scope','export-package-inventory','export-power-platform-inventory') AND target_blocked_state IS NULL));
` },
  { version: 24, sql: `
ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_state;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_check CHECK (action IN (
  'block','unblock','update-availability','update-installation','reassign','view-audit-search','export-audit-search',
  'view-hunting','export-hunting','approve-hunting','qualify-hunting','submit-hunting','query-hunting','cancel-hunting','delete-hunting',
  'revoke-hunting-scope','export-package-inventory','export-power-platform-inventory',
  'export-official-usage-aggregate','export-official-usage-users'));
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_state CHECK (
  (action IN ('block','unblock') AND target_blocked_state IS NOT NULL)
  OR (action IN ('update-availability','update-installation','reassign','view-audit-search','export-audit-search',
    'view-hunting','export-hunting','approve-hunting','qualify-hunting','submit-hunting','query-hunting','cancel-hunting','delete-hunting',
    'revoke-hunting-scope','export-package-inventory','export-power-platform-inventory',
    'export-official-usage-aggregate','export-official-usage-users') AND target_blocked_state IS NULL));
` },
  { version: 25, sql: `
ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_state;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_check CHECK (action IN (
  'block','unblock','update-availability','update-installation','reassign','view-audit-search','export-audit-search',
  'view-hunting','export-hunting','approve-hunting','qualify-hunting','submit-hunting','query-hunting','cancel-hunting','delete-hunting',
  'revoke-hunting-scope','export-package-inventory','export-power-platform-inventory',
  'export-official-usage-aggregate','export-official-usage-users','export-administrative-audit'));
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_state CHECK (
  (action IN ('block','unblock') AND target_blocked_state IS NOT NULL)
  OR (action NOT IN ('block','unblock') AND target_blocked_state IS NULL));
` },
  { version: 26, sql: `
CREATE TABLE operational_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  mode text NOT NULL CHECK (mode IN ('normal','maintenance')),
  provider_work_enabled boolean NOT NULL,
  restored_from_at timestamptz,
  deletion_reviewed_at timestamptz,
  access_reviewed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((restored_from_at IS NULL AND deletion_reviewed_at IS NULL AND access_reviewed_at IS NULL)
    OR (restored_from_at IS NOT NULL AND deletion_reviewed_at IS NOT NULL AND access_reviewed_at IS NOT NULL))
);
INSERT INTO operational_state(singleton,mode,provider_work_enabled) VALUES(true,'normal',true);
` },
  { version: 27, sql: `
ALTER TABLE power_platform_refresh_jobs DROP CONSTRAINT power_platform_refresh_jobs_status_check;
ALTER TABLE power_platform_refresh_jobs ADD CONSTRAINT power_platform_refresh_jobs_status_check CHECK (status IN ('waiting_authorization','running','succeeded','failed','cancelled'));
ALTER TABLE package_refresh_jobs DROP CONSTRAINT package_refresh_jobs_status_check;
ALTER TABLE package_refresh_jobs ADD CONSTRAINT package_refresh_jobs_status_check CHECK (status IN ('waiting_authorization','running','succeeded','failed','cancelled'));
` },
] as const;

export function migrationChecksum(sql: string) {
  return createHash("sha256").update(sql).digest("hex");
}

export async function verifySchema(database: Pick<pg.Pool, "query">) {
  const { rows } = await database.query<{ version: number; checksum: string }>(
    "SELECT version, checksum FROM schema_migrations ORDER BY version",
  );
  if (rows.length !== migrations.length || rows.some((row, index) =>
    row.version !== migrations[index]?.version || row.checksum !== migrationChecksum(migrations[index].sql))) {
    throw new Error("Database schema is missing, modified or newer than this artifact; operator migration required.");
  }
}