export const dataSyncMigrationSql = `
CREATE TABLE data_sync_runs (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  principal_id text NOT NULL CHECK (length(principal_id) BETWEEN 1 AND 256),
  mode text NOT NULL CHECK (mode IN ('initial','incremental','full')),
  source_ids jsonb NOT NULL CHECK (
    jsonb_typeof(source_ids)='array'
    AND jsonb_array_length(source_ids) BETWEEN 1 AND 4
    AND octet_length(source_ids::text) <= 256
  ),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','waiting','completed','partial','cancelled')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '30 days',
  UNIQUE (id, tenant_id, principal_id)
);
CREATE UNIQUE INDEX data_sync_one_active_run
  ON data_sync_runs(tenant_id,principal_id)
  WHERE status IN ('running','waiting');
CREATE INDEX data_sync_runs_scope
  ON data_sync_runs(tenant_id,principal_id,started_at DESC,id DESC);
CREATE INDEX data_sync_runs_expiry ON data_sync_runs(expires_at);

CREATE TABLE data_sync_run_sources (
  run_id uuid NOT NULL,
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  principal_id text NOT NULL CHECK (length(principal_id) BETWEEN 1 AND 256),
  source_id text NOT NULL CHECK (source_id IN ('users','graph_packages','power_platform','usage_reports')),
  status text NOT NULL CHECK (status IN (
    'not_started','queued','running','waiting_authorization','permission_required',
    'awaiting_upload','succeeded','partial','failed','cancelled'
  )),
  job_id uuid,
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 20),
  count integer CHECK (count IS NULL OR count >= 0),
  last_success_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  message text NOT NULL CHECK (length(message) BETWEEN 1 AND 1024),
  can_retry boolean NOT NULL DEFAULT false,
  PRIMARY KEY (run_id,source_id),
  FOREIGN KEY (run_id,tenant_id,principal_id)
    REFERENCES data_sync_runs(id,tenant_id,principal_id) ON DELETE CASCADE
);
CREATE INDEX data_sync_run_sources_scope
  ON data_sync_run_sources(tenant_id,principal_id,updated_at DESC);

CREATE TABLE data_sync_source_jobs (
  run_id uuid NOT NULL,
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  principal_id text NOT NULL CHECK (length(principal_id) BETWEEN 1 AND 256),
  source_id text NOT NULL CHECK (source_id IN ('users','graph_packages','power_platform')),
  attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 20),
  job_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (run_id,source_id,attempt),
  UNIQUE (job_id),
  FOREIGN KEY (run_id,tenant_id,principal_id)
    REFERENCES data_sync_runs(id,tenant_id,principal_id) ON DELETE CASCADE
);

CREATE TABLE data_sync_success_markers (
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  principal_id text NOT NULL CHECK (length(principal_id) BETWEEN 1 AND 256),
  source_id text NOT NULL CHECK (source_id IN ('users','graph_packages','power_platform','usage_reports')),
  count integer CHECK (count IS NULL OR count >= 0),
  last_success_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,principal_id,source_id)
);

CREATE TABLE copilot_usage_snapshots (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  principal_id text NOT NULL CHECK (length(principal_id) BETWEEN 1 AND 256),
  source_id text NOT NULL CHECK (source_id IN ('directory','app_activity')),
  snapshot_data jsonb NOT NULL CHECK (
    jsonb_typeof(snapshot_data) IN ('array','object')
    AND octet_length(snapshot_data::text) <= 33554432
  ),
  row_count integer NOT NULL CHECK (row_count BETWEEN 0 AND 100000),
  is_current boolean NOT NULL DEFAULT true,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '30 days',
  UNIQUE (id,tenant_id,principal_id,source_id)
);
CREATE UNIQUE INDEX copilot_usage_one_current_snapshot
  ON copilot_usage_snapshots(tenant_id,principal_id,source_id)
  WHERE is_current;
CREATE INDEX copilot_usage_snapshots_scope
  ON copilot_usage_snapshots(tenant_id,principal_id,source_id,observed_at DESC);
CREATE INDEX copilot_usage_snapshots_expiry ON copilot_usage_snapshots(expires_at);

CREATE TABLE copilot_usage_source_state (
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  principal_id text NOT NULL CHECK (length(principal_id) BETWEEN 1 AND 256),
  source_id text NOT NULL CHECK (source_id IN ('directory','app_activity')),
  attempt_status text NOT NULL CHECK (attempt_status IN (
    'available','waiting_authorization','permission_required','failed'
  )),
  message text NOT NULL CHECK (length(message) BETWEEN 1 AND 1024),
  attempted_at timestamptz NOT NULL,
  last_success_at timestamptz,
  row_count integer CHECK (row_count IS NULL OR row_count BETWEEN 0 AND 100000),
  current_snapshot_id uuid,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,principal_id,source_id)
);

CREATE FUNCTION protect_data_sync_run_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.tenant_id,NEW.principal_id,NEW.mode,NEW.source_ids,NEW.request_hash,NEW.started_at,NEW.expires_at)
    IS DISTINCT FROM
     (OLD.id,OLD.tenant_id,OLD.principal_id,OLD.mode,OLD.source_ids,OLD.request_hash,OLD.started_at,OLD.expires_at)
  THEN RAISE EXCEPTION 'data sync run intent is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_data_sync_run_intent
  BEFORE UPDATE ON data_sync_runs
  FOR EACH ROW EXECUTE FUNCTION protect_data_sync_run_intent();

CREATE FUNCTION protect_data_sync_source_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.run_id,NEW.tenant_id,NEW.principal_id,NEW.source_id)
    IS DISTINCT FROM (OLD.run_id,OLD.tenant_id,OLD.principal_id,OLD.source_id)
  THEN RAISE EXCEPTION 'data sync source identity is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_data_sync_source_identity
  BEFORE UPDATE ON data_sync_run_sources
  FOR EACH ROW EXECUTE FUNCTION protect_data_sync_source_identity();

CREATE FUNCTION protect_copilot_usage_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.tenant_id,NEW.principal_id,NEW.source_id,NEW.snapshot_data,NEW.row_count,NEW.observed_at,NEW.created_at)
    IS DISTINCT FROM
     (OLD.id,OLD.tenant_id,OLD.principal_id,OLD.source_id,OLD.snapshot_data,OLD.row_count,OLD.observed_at,OLD.created_at)
  THEN RAISE EXCEPTION 'Copilot usage snapshot content is immutable'; END IF;
  IF OLD.is_current=false AND NEW.is_current=true
  THEN RAISE EXCEPTION 'Copilot usage snapshots cannot become current again'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_copilot_usage_snapshot
  BEFORE UPDATE ON copilot_usage_snapshots
  FOR EACH ROW EXECUTE FUNCTION protect_copilot_usage_snapshot();
`;

export const copilotServiceSnapshotResetMigrationSql = `
DELETE FROM copilot_usage_source_state WHERE source_id IN ('directory','app_activity');
DELETE FROM copilot_usage_snapshots WHERE source_id IN ('directory','app_activity');
DELETE FROM data_sync_success_markers WHERE source_id='users';

ALTER TABLE copilot_usage_snapshots ADD CONSTRAINT copilot_directory_service_format CHECK (
  source_id<>'directory' OR COALESCE(
    jsonb_typeof(snapshot_data)='object'
    AND snapshot_data @> '{"serviceEvidenceVersion":1}'::jsonb
    AND jsonb_typeof(snapshot_data->'users')='array',
    false
  )
);
`;
