export const automaticDataSyncMigrationSql = `
ALTER TABLE data_sync_runs ADD COLUMN automatic boolean NOT NULL DEFAULT false;
ALTER TABLE data_sync_runs ADD CONSTRAINT automatic_data_sync_scope CHECK (
  NOT automatic OR (mode='incremental' AND NOT clear_saved_data AND NOT (source_ids ? 'usage_reports'))
);
CREATE OR REPLACE FUNCTION protect_data_sync_run_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.tenant_id,NEW.principal_id,NEW.mode,NEW.source_ids,NEW.request_hash,NEW.started_at,NEW.expires_at,NEW.clear_saved_data,NEW.automatic)
    IS DISTINCT FROM
     (OLD.id,OLD.tenant_id,OLD.principal_id,OLD.mode,OLD.source_ids,OLD.request_hash,OLD.started_at,OLD.expires_at,OLD.clear_saved_data,OLD.automatic)
  THEN RAISE EXCEPTION 'data sync run intent is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE INDEX data_sync_source_due ON data_sync_run_sources(tenant_id,principal_id,source_id,updated_at DESC);
`;
