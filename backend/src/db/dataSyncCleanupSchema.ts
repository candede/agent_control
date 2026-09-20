export const dataSyncCleanupMigrationSql = `
ALTER TABLE data_sync_runs ADD COLUMN clear_saved_data boolean NOT NULL DEFAULT false;
ALTER TABLE data_sync_runs ADD CONSTRAINT data_sync_cleanup_full_scope CHECK (
  NOT clear_saved_data OR (
    mode='full' AND jsonb_array_length(source_ids)=4
    AND source_ids @> '["users","graph_packages","power_platform","usage_reports"]'::jsonb
  )
);

CREATE OR REPLACE FUNCTION protect_data_sync_run_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.tenant_id,NEW.principal_id,NEW.mode,NEW.source_ids,NEW.request_hash,NEW.started_at,NEW.expires_at,NEW.clear_saved_data)
    IS DISTINCT FROM
     (OLD.id,OLD.tenant_id,OLD.principal_id,OLD.mode,OLD.source_ids,OLD.request_hash,OLD.started_at,OLD.expires_at,OLD.clear_saved_data)
  THEN RAISE EXCEPTION 'data sync run intent is immutable'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION clear_admitted_data_sync_snapshots() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('data-sync:'||NEW.tenant_id||':'||NEW.principal_id,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('package-refresh:'||NEW.tenant_id||':'||NEW.principal_id,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('power-platform:'||NEW.tenant_id||':'||NEW.principal_id,0));
  IF EXISTS (
    SELECT 1 FROM public.package_refresh_jobs
    WHERE tenant_id=NEW.tenant_id AND principal_id=NEW.principal_id
      AND status IN ('waiting_authorization','running')
      AND expires_at>clock_timestamp() AND deadline_at>clock_timestamp()
  ) OR EXISTS (
    SELECT 1 FROM public.power_platform_refresh_jobs
    WHERE tenant_id=NEW.tenant_id AND principal_id=NEW.principal_id
      AND status IN ('waiting_authorization','running')
      AND expires_at>clock_timestamp() AND deadline_at>clock_timestamp()
  ) THEN
    RAISE EXCEPTION USING ERRCODE='PDS01',
      MESSAGE='Finish or cancel active Graph package and Power Platform refresh jobs before clearing saved data.';
  END IF;

  DELETE FROM public.copilot_usage_source_state WHERE tenant_id=NEW.tenant_id AND principal_id=NEW.principal_id;
  DELETE FROM public.copilot_usage_snapshots WHERE tenant_id=NEW.tenant_id AND principal_id=NEW.principal_id;
  DELETE FROM public.package_inventory_snapshots WHERE tenant_id=NEW.tenant_id AND principal_id=NEW.principal_id;
  DELETE FROM public.power_platform_inventory_snapshots WHERE tenant_id=NEW.tenant_id AND principal_id=NEW.principal_id;
  DELETE FROM public.data_sync_success_markers
    WHERE tenant_id=NEW.tenant_id AND principal_id=NEW.principal_id
      AND source_id IN ('users','graph_packages','power_platform');
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION clear_admitted_data_sync_snapshots() FROM PUBLIC;
CREATE TRIGGER clear_admitted_data_sync_snapshots
  AFTER INSERT ON data_sync_runs
  FOR EACH ROW WHEN (NEW.clear_saved_data)
  EXECUTE FUNCTION clear_admitted_data_sync_snapshots();
`;

export const dataSyncAutomaticSourcesMigrationSql = `
ALTER TABLE data_sync_runs DROP CONSTRAINT data_sync_cleanup_full_scope;
ALTER TABLE data_sync_runs ADD CONSTRAINT data_sync_cleanup_full_scope CHECK (
  NOT clear_saved_data OR (
    mode='full' AND source_ids @> '["users","graph_packages","power_platform"]'::jsonb
    AND (
      jsonb_array_length(source_ids)=3
      OR (jsonb_array_length(source_ids)=4 AND source_ids @> '["usage_reports"]'::jsonb)
    )
  )
);
`;
