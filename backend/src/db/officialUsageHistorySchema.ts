export const officialUsageHistoryMigrationSql = `
CREATE FUNCTION official_usage_payload_hash(payload jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT encode(sha256(convert_to(payload::text,'UTF8')),'hex')
$$;

CREATE FUNCTION official_usage_report_content_hash(
  report_kind text,
  report_schema_version text,
  report_start date,
  report_end date,
  report_period_provenance text,
  report_source_as_of timestamptz,
  report_source_as_of_provenance text,
  report_source_freshness text,
  report_rows jsonb
) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT official_usage_payload_hash(jsonb_build_object(
    'kind',report_kind,
    'schemaVersion',report_schema_version,
    'reportingPeriod',jsonb_build_object(
      'startDate',report_start,
      'endDate',report_end,
      'provenance',report_period_provenance
    ),
    'source',jsonb_build_object(
      'asOf',CASE WHEN report_source_as_of IS NULL THEN NULL
        ELSE to_char(report_source_as_of AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
      'asOfProvenance',report_source_as_of_provenance,
      'freshness',report_source_freshness
    ),
    'rows',COALESCE((
      SELECT jsonb_agg(item ORDER BY item::text)
      FROM jsonb_array_elements(report_rows) item
    ),'[]'::jsonb)
  ))
$$;

CREATE FUNCTION official_usage_bundle_content_hash(report_versions jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT official_usage_payload_hash(COALESCE((
    SELECT jsonb_agg(item ORDER BY item->>'kind')
    FROM jsonb_array_elements(report_versions) item
  ),'[]'::jsonb))
$$;

ALTER TABLE official_usage_staging ADD COLUMN content_hash text
  CHECK (content_hash IS NULL OR content_hash ~ '^[a-f0-9]{64}$');
ALTER TABLE official_usage_versions ADD COLUMN content_hash text
  CHECK (content_hash IS NULL OR content_hash ~ '^[a-f0-9]{64}$');
ALTER TABLE official_usage_sets ADD COLUMN content_hash text
  CHECK (content_hash IS NULL OR content_hash ~ '^[a-f0-9]{64}$');

UPDATE official_usage_staging staging SET content_hash=official_usage_report_content_hash(
  staging.kind,staging.schema_version,staging.reporting_start,staging.reporting_end,
  staging.period_provenance,staging.source_as_of,staging.source_as_of_provenance,
  staging.source_freshness,COALESCE((
    SELECT jsonb_agg(row.row_data ORDER BY row.row_data::text)
    FROM official_usage_staged_rows row WHERE row.staging_id=staging.id
  ),'[]'::jsonb)
) WHERE staging.status='active';

UPDATE official_usage_versions version SET content_hash=official_usage_report_content_hash(
  version.kind,artifact.schema_version,version.reporting_start,version.reporting_end,
  version.period_provenance,version.source_as_of,version.source_as_of_provenance,
  version.source_freshness,COALESCE((
    SELECT jsonb_agg(row.row_data ORDER BY row.row_data::text)
    FROM official_usage_version_rows row WHERE row.version_id=version.id
  ),'[]'::jsonb)
) FROM official_usage_artifacts artifact WHERE artifact.id=version.artifact_id;

UPDATE official_usage_sets report_set SET content_hash=official_usage_bundle_content_hash(COALESCE((
  SELECT jsonb_agg(jsonb_build_object('kind',membership.kind,'contentHash',version.content_hash)
    ORDER BY membership.kind)
  FROM official_usage_set_versions membership
  JOIN official_usage_versions version ON version.id=membership.version_id
  WHERE membership.set_id=report_set.id
),'[]'::jsonb)) WHERE report_set.complete;

ALTER TABLE official_usage_staging ADD CONSTRAINT official_usage_staging_content_hash_state
  CHECK (status<>'active' OR content_hash IS NOT NULL);
ALTER TABLE official_usage_versions ALTER COLUMN content_hash SET NOT NULL;
ALTER TABLE official_usage_sets ADD CONSTRAINT official_usage_sets_content_hash_state
  CHECK ((complete AND content_hash IS NOT NULL) OR (NOT complete AND content_hash IS NULL));
CREATE INDEX official_usage_versions_content_hash
  ON official_usage_versions(tenant_id,kind,content_hash,accepted_at);
CREATE INDEX official_usage_sets_content_hash
  ON official_usage_sets(tenant_id,content_hash,accepted_at);

CREATE TABLE official_usage_row_facts (
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  kind text NOT NULL CHECK (kind IN ('agents','userAgents','users')),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  row_data jsonb NOT NULL CHECK (
    jsonb_typeof(row_data)='object'
    AND octet_length(row_data::text)<=16384
    AND payload_hash=official_usage_payload_hash(row_data)
  ),
  first_observed_at timestamptz NOT NULL,
  PRIMARY KEY(tenant_id,kind,payload_hash)
);
CREATE INDEX official_usage_row_facts_observed
  ON official_usage_row_facts(tenant_id,first_observed_at,kind,payload_hash);

INSERT INTO official_usage_row_facts(tenant_id,kind,payload_hash,row_data,first_observed_at)
SELECT row.tenant_id,row.kind,official_usage_payload_hash(row.row_data),row.row_data,min(version.accepted_at)
FROM official_usage_version_rows row
JOIN official_usage_versions version ON version.id=row.version_id
GROUP BY row.tenant_id,row.kind,official_usage_payload_hash(row.row_data),row.row_data
ON CONFLICT(tenant_id,kind,payload_hash) DO UPDATE
  SET first_observed_at=LEAST(official_usage_row_facts.first_observed_at,EXCLUDED.first_observed_at);

ALTER TABLE official_usage_version_rows ADD COLUMN payload_hash text;
UPDATE official_usage_version_rows SET payload_hash=official_usage_payload_hash(row_data);
ALTER TABLE official_usage_version_rows ALTER COLUMN payload_hash SET NOT NULL;
ALTER TABLE official_usage_version_rows ADD CONSTRAINT official_usage_version_rows_fact_fkey
  FOREIGN KEY(tenant_id,kind,payload_hash)
  REFERENCES official_usage_row_facts(tenant_id,kind,payload_hash) ON DELETE RESTRICT;
ALTER TABLE official_usage_version_rows DROP COLUMN row_data;
CREATE INDEX official_usage_version_rows_payload
  ON official_usage_version_rows(tenant_id,kind,payload_hash,version_id);

ALTER TABLE official_usage_set_versions
  DROP CONSTRAINT official_usage_set_versions_version_id_key;
CREATE INDEX official_usage_set_versions_version
  ON official_usage_set_versions(tenant_id,version_id,set_id);

ALTER TABLE official_usage_artifacts ALTER COLUMN expires_at DROP NOT NULL;
ALTER TABLE official_usage_sets ALTER COLUMN expires_at DROP NOT NULL;
ALTER TABLE official_usage_versions ALTER COLUMN expires_at DROP NOT NULL;
ALTER TABLE official_usage_artifacts ALTER COLUMN expires_at DROP DEFAULT;
ALTER TABLE official_usage_sets ALTER COLUMN expires_at DROP DEFAULT;
ALTER TABLE official_usage_versions ALTER COLUMN expires_at DROP DEFAULT;
UPDATE official_usage_artifacts SET expires_at=NULL;
UPDATE official_usage_sets SET expires_at=NULL WHERE deleted_at IS NULL;
UPDATE official_usage_versions SET expires_at=NULL WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION protect_official_usage_staging() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user<>'agentcontrol_app' THEN RETURN NEW; END IF;
  IF (NEW.id,NEW.tenant_id,NEW.actor_principal_id,NEW.revision,NEW.kind,NEW.file_hash,NEW.content_hash,
      NEW.parser_version,NEW.schema_version,NEW.bundle_id,NEW.correction_of_set_id,NEW.reporting_start,
      NEW.reporting_end,NEW.period_provenance,NEW.source_as_of,NEW.source_as_of_provenance,
      NEW.source_freshness,NEW.downloaded_at,NEW.row_count,NEW.stored_bytes,NEW.warnings,
      NEW.reconciliation,NEW.active_revision,NEW.created_at,NEW.expires_at)
    IS DISTINCT FROM
     (OLD.id,OLD.tenant_id,OLD.actor_principal_id,OLD.revision,OLD.kind,OLD.file_hash,OLD.content_hash,
      OLD.parser_version,OLD.schema_version,OLD.bundle_id,OLD.correction_of_set_id,OLD.reporting_start,
      OLD.reporting_end,OLD.period_provenance,OLD.source_as_of,OLD.source_as_of_provenance,
      OLD.source_freshness,OLD.downloaded_at,OLD.row_count,OLD.stored_bytes,OLD.warnings,
      OLD.reconciliation,OLD.active_revision,OLD.created_at,OLD.expires_at)
  THEN RAISE EXCEPTION 'official usage staging intent is immutable'; END IF;
  IF OLD.status<>'active' OR NEW.status NOT IN ('accepted','replaced','expired','cancelled')
  THEN RAISE EXCEPTION 'official usage staging transition is invalid'; END IF;
  IF NEW.status='accepted' THEN
    IF NEW.accepted_version_id IS NULL OR NEW.accepted_set_id IS NULL OR NEW.accepted_at IS NULL
      OR NEW.accepted_result_revision IS NULL
    THEN RAISE EXCEPTION 'official usage acceptance receipt is incomplete'; END IF;
  ELSIF (NEW.accepted_version_id,NEW.accepted_set_id,NEW.accepted_at,NEW.accepted_result_revision)
    IS DISTINCT FROM (OLD.accepted_version_id,OLD.accepted_set_id,OLD.accepted_at,OLD.accepted_result_revision)
  THEN RAISE EXCEPTION 'official usage staging receipt is invalid'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION protect_official_usage_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.tenant_id,NEW.artifact_id,NEW.staging_id,NEW.kind,NEW.content_hash,
      NEW.reporting_start,NEW.reporting_end,NEW.period_provenance,NEW.source_as_of,
      NEW.source_as_of_provenance,NEW.source_freshness,NEW.downloaded_at,NEW.row_count,
      NEW.warnings,NEW.reconciliation,NEW.accepted_by,NEW.supersedes_version_id,NEW.accepted_at)
    IS DISTINCT FROM
     (OLD.id,OLD.tenant_id,OLD.artifact_id,OLD.staging_id,OLD.kind,OLD.content_hash,
      OLD.reporting_start,OLD.reporting_end,OLD.period_provenance,OLD.source_as_of,
      OLD.source_as_of_provenance,OLD.source_freshness,OLD.downloaded_at,OLD.row_count,
      OLD.warnings,OLD.reconciliation,OLD.accepted_by,OLD.supersedes_version_id,OLD.accepted_at)
  THEN RAISE EXCEPTION 'official usage version is immutable'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION protect_official_usage_set() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user<>'agentcontrol_app' THEN RETURN NEW; END IF;
  IF (NEW.id,NEW.tenant_id,NEW.bundle_id,NEW.actor_principal_id,NEW.period_provenance,
      NEW.supersedes_set_id,NEW.created_at,NEW.expires_at)
    IS DISTINCT FROM
     (OLD.id,OLD.tenant_id,OLD.bundle_id,OLD.actor_principal_id,OLD.period_provenance,
      OLD.supersedes_set_id,OLD.created_at,OLD.expires_at)
  THEN RAISE EXCEPTION 'official usage set identity is immutable'; END IF;
  IF OLD.complete AND (NEW.reporting_start,NEW.reporting_end,NEW.content_hash)
    IS DISTINCT FROM (OLD.reporting_start,OLD.reporting_end,OLD.content_hash)
  THEN RAISE EXCEPTION 'official usage complete set observation is immutable'; END IF;
  IF NOT OLD.complete AND (
    (OLD.reporting_start IS NOT NULL AND (NEW.reporting_start IS NULL OR NEW.reporting_start>OLD.reporting_start))
    OR (OLD.reporting_end IS NOT NULL AND (NEW.reporting_end IS NULL OR NEW.reporting_end<OLD.reporting_end)))
  THEN RAISE EXCEPTION 'official usage set activity range cannot narrow'; END IF;
  IF NOT OLD.complete AND NEW.content_hash IS NOT NULL AND NOT NEW.complete
  THEN RAISE EXCEPTION 'official usage incomplete set cannot have a content hash'; END IF;
  IF NEW.complete AND NEW.content_hash IS NULL
  THEN RAISE EXCEPTION 'official usage set completion requires a content hash'; END IF;
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

CREATE OR REPLACE FUNCTION protect_official_usage_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE live_kinds integer;
BEGIN
  IF current_user<>'agentcontrol_app' THEN RETURN NEW; END IF;
  IF NEW.tenant_id<>OLD.tenant_id OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at
  THEN RAISE EXCEPTION 'official usage selection revision is invalid'; END IF;
  IF NEW.active_set_id IS NOT NULL THEN
    SELECT count(*) INTO live_kinds FROM official_usage_sets report_set
      JOIN official_usage_set_versions membership ON membership.set_id=report_set.id
        AND membership.tenant_id=report_set.tenant_id
      JOIN official_usage_versions version ON version.id=membership.version_id
        AND version.tenant_id=membership.tenant_id AND version.kind=membership.kind
      WHERE report_set.id=NEW.active_set_id AND report_set.tenant_id=NEW.tenant_id
        AND report_set.complete AND report_set.deleted_at IS NULL AND version.deleted_at IS NULL;
    IF live_kinds<>3 THEN RAISE EXCEPTION 'official usage selection requires three live report kinds'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION protect_official_usage_row_fact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user='agentcontrol_app' AND TG_OP<>'INSERT'
  THEN RAISE EXCEPTION 'official usage row fact is immutable'; END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER immutable_official_usage_row_fact
  BEFORE UPDATE OR DELETE ON official_usage_row_facts
  FOR EACH ROW EXECUTE FUNCTION protect_official_usage_row_fact();

REVOKE ALL ON FUNCTION official_usage_payload_hash(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION official_usage_report_content_hash(text,text,date,date,text,timestamptz,text,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION official_usage_bundle_content_hash(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION protect_official_usage_row_fact() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION official_usage_payload_hash(jsonb) TO agentcontrol_app;
GRANT EXECUTE ON FUNCTION official_usage_report_content_hash(text,text,date,date,text,timestamptz,text,text,jsonb) TO agentcontrol_app;
GRANT EXECUTE ON FUNCTION official_usage_bundle_content_hash(jsonb) TO agentcontrol_app;
GRANT SELECT,INSERT ON official_usage_row_facts TO agentcontrol_app;
`;
