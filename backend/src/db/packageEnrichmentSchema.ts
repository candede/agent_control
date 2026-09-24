import type pg from "pg";

export const packageEnrichmentMigrationSql = `
ALTER TABLE package_refresh_jobs
  ADD COLUMN catalog_only boolean NOT NULL DEFAULT false,
  ADD COLUMN auto_details boolean NOT NULL DEFAULT false,
  ADD COLUMN detail_targets jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT package_refresh_detail_mode CHECK (
    (NOT catalog_only OR (scope_kind='broad' AND NOT auto_details))
    AND (NOT auto_details OR (scope_kind='exact' AND token_mode='delegated'
      AND jsonb_array_length(requested_ids) BETWEEN 1 AND 20))
    AND jsonb_typeof(detail_targets)='array' AND jsonb_array_length(detail_targets)<=20
  );
CREATE INDEX package_auto_detail_jobs ON package_refresh_jobs(tenant_id,principal_id,deadline_at)
  WHERE auto_details AND status IN ('waiting_authorization','running');
ALTER TABLE package_inventory_snapshots ADD COLUMN catalog_only boolean NOT NULL DEFAULT false;

CREATE TABLE package_detail_cache (
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  principal_id text NOT NULL CHECK (length(principal_id) BETWEEN 1 AND 256),
  token_mode text NOT NULL CHECK (token_mode IN ('delegated','application')),
  native_id text NOT NULL CHECK (length(native_id) BETWEEN 1 AND 512),
  generation uuid NOT NULL DEFAULT gen_random_uuid(),
  catalog_revision jsonb NOT NULL CHECK (jsonb_typeof(catalog_revision)='array' AND jsonb_array_length(catalog_revision)=6),
  -- The existing 2 MiB source payload plus a legacy collection-proof marker.
  package_data jsonb CHECK (package_data IS NULL OR (
    jsonb_typeof(package_data)='object' AND package_data->>'id'=native_id AND octet_length(package_data::text)<=2097216)),
  detail_snapshot_id uuid,
  observed_at timestamptz,
  read_started_at timestamptz,
  expires_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count BETWEEN 0 AND 10),
  PRIMARY KEY(tenant_id,principal_id,token_mode,native_id)
);
CREATE INDEX package_detail_cache_due ON package_detail_cache(tenant_id,principal_id,token_mode,next_attempt_at);

CREATE FUNCTION package_detail_revision(value jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT jsonb_build_array(value->>'lastModifiedDateTime',value->>'appId',value->>'manifestId',
    value->>'assetId',value->>'version',value->>'manifestVersion')
$$;

CREATE FUNCTION package_detail_has_evidence(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(value->'identityDetailsCollected'='true'::jsonb,false) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(value->'elementDetails')='array' THEN value->'elementDetails' ELSE '[]'::jsonb END
    ) detail
    WHERE jsonb_typeof(detail->'elementType')='string' AND length(detail->>'elementType')>0
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(detail->'elements')='array' THEN detail->'elements' ELSE '[]'::jsonb END
        ) element
        WHERE jsonb_typeof(element->'id')='string' AND jsonb_typeof(element->'definition')='string'
      )
  )
$$;

CREATE FUNCTION package_detail_current_catalog(p_tenant text,p_principal text,p_mode text)
RETURNS TABLE(native_id text,snapshot_id uuid,read_started_at timestamptz,package_data jsonb)
LANGUAGE sql VOLATILE SET search_path=pg_catalog,public,pg_temp AS $$
  WITH targets AS (
    SELECT DISTINCT resource.native_id FROM public.package_inventory_resources resource
    JOIN public.package_inventory_snapshots snapshot ON snapshot.id=resource.snapshot_id
    WHERE snapshot.tenant_id=p_tenant AND snapshot.principal_id=p_principal AND snapshot.token_mode=p_mode
      AND snapshot.observation_kind='inventory' AND snapshot.is_current AND snapshot.expires_at>clock_timestamp()
      AND resource.tenant_id=p_tenant AND resource.principal_id=p_principal
  )
  SELECT targets.native_id,current.id,current.read_started_at,resource.package_data FROM targets
  JOIN LATERAL (
    SELECT snapshot.id,snapshot.read_started_at FROM public.package_inventory_snapshots snapshot
    WHERE snapshot.tenant_id=p_tenant AND snapshot.principal_id=p_principal AND snapshot.token_mode=p_mode
      AND snapshot.observation_kind='inventory' AND snapshot.is_current AND snapshot.expires_at>clock_timestamp()
      AND (snapshot.scope_kind='broad' OR snapshot.requested_ids ? targets.native_id)
    ORDER BY date_trunc('milliseconds',snapshot.read_started_at) DESC,snapshot.id DESC LIMIT 1
  ) current ON true
  JOIN public.package_inventory_resources resource ON resource.snapshot_id=current.id
    AND resource.tenant_id=p_tenant AND resource.principal_id=p_principal AND resource.native_id=targets.native_id
$$;

INSERT INTO package_detail_cache(tenant_id,principal_id,token_mode,native_id,catalog_revision,
  package_data,detail_snapshot_id,observed_at,read_started_at,expires_at,next_attempt_at)
SELECT scope.tenant_id,scope.principal_id,scope.token_mode,current.native_id,
  package_detail_revision(current.package_data),current.package_data || '{"identityDetailsCollected":true}'::jsonb,current.snapshot_id,
  current.read_started_at,current.read_started_at,current.read_started_at+interval '1 hour',
  current.read_started_at+interval '1 hour'
FROM (SELECT DISTINCT tenant_id,principal_id,token_mode FROM package_inventory_snapshots
  WHERE is_current AND observation_kind='inventory' AND expires_at>clock_timestamp()) scope
CROSS JOIN LATERAL package_detail_current_catalog(scope.tenant_id,scope.principal_id,scope.token_mode) current
JOIN package_inventory_snapshots snapshot ON snapshot.id=current.snapshot_id
WHERE package_detail_has_evidence(current.package_data)
  OR (snapshot.scope_kind='exact' AND snapshot.job_id IS NOT NULL);

INSERT INTO package_detail_cache(tenant_id,principal_id,token_mode,native_id,catalog_revision)
SELECT scope.tenant_id,scope.principal_id,scope.token_mode,current.native_id,package_detail_revision(current.package_data)
FROM (SELECT DISTINCT tenant_id,principal_id,token_mode FROM package_inventory_snapshots
  WHERE is_current AND observation_kind='inventory' AND expires_at>clock_timestamp()) scope
CROSS JOIN LATERAL package_detail_current_catalog(scope.tenant_id,scope.principal_id,scope.token_mode) current
ON CONFLICT(tenant_id,principal_id,token_mode,native_id) DO NOTHING;

-- Run after complete inventory publication, never while catalog rows are still being inserted.
CREATE FUNCTION reconcile_package_detail_cache() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  WITH current AS MATERIALIZED (
    SELECT * FROM public.package_detail_current_catalog(NEW.tenant_id,NEW.principal_id,NEW.token_mode)
  )
  DELETE FROM public.package_detail_cache cache
  WHERE cache.tenant_id=NEW.tenant_id AND cache.principal_id=NEW.principal_id AND cache.token_mode=NEW.token_mode
    AND NOT EXISTS (
      SELECT 1 FROM current
      WHERE current.native_id=cache.native_id
        AND public.package_detail_revision(current.package_data)=cache.catalog_revision
    );
  INSERT INTO public.package_detail_cache(tenant_id,principal_id,token_mode,native_id,catalog_revision)
    SELECT NEW.tenant_id,NEW.principal_id,NEW.token_mode,current.native_id,
      public.package_detail_revision(current.package_data)
    FROM public.package_detail_current_catalog(NEW.tenant_id,NEW.principal_id,NEW.token_mode) current
    ON CONFLICT(tenant_id,principal_id,token_mode,native_id) DO NOTHING;
  IF NOT NEW.catalog_only THEN
    INSERT INTO public.package_detail_cache(tenant_id,principal_id,token_mode,native_id,catalog_revision,
      package_data,detail_snapshot_id,observed_at,read_started_at,expires_at,next_attempt_at)
    SELECT NEW.tenant_id,NEW.principal_id,NEW.token_mode,current.native_id,
      public.package_detail_revision(current.package_data),current.package_data || '{"identityDetailsCollected":true}'::jsonb,snapshot.id,
      snapshot.read_started_at,snapshot.read_started_at,snapshot.read_started_at+interval '1 hour',
      snapshot.read_started_at+interval '1 hour'
    FROM public.package_detail_current_catalog(NEW.tenant_id,NEW.principal_id,NEW.token_mode) current
    JOIN public.package_inventory_snapshots snapshot ON snapshot.id=current.snapshot_id AND snapshot.job_id=NEW.id
    WHERE public.package_detail_has_evidence(current.package_data)
      OR (snapshot.scope_kind='exact' AND snapshot.job_id IS NOT NULL)
    ON CONFLICT(tenant_id,principal_id,token_mode,native_id) DO UPDATE
      SET package_data=EXCLUDED.package_data,detail_snapshot_id=EXCLUDED.detail_snapshot_id,
        observed_at=EXCLUDED.observed_at,read_started_at=EXCLUDED.read_started_at,
        expires_at=EXCLUDED.expires_at,next_attempt_at=EXCLUDED.next_attempt_at,failure_count=0
      WHERE package_detail_cache.read_started_at IS NULL
        OR package_detail_cache.read_started_at<=EXCLUDED.read_started_at;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reconcile_package_detail_cache AFTER UPDATE OF status ON package_refresh_jobs
  FOR EACH ROW WHEN (NEW.status='succeeded' AND OLD.status IS DISTINCT FROM NEW.status AND NOT NEW.auto_details)
  EXECUTE FUNCTION reconcile_package_detail_cache();

CREATE FUNCTION backoff_package_detail_job() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  UPDATE public.package_detail_cache cache SET failure_count=LEAST(cache.failure_count+1,10),
    next_attempt_at=GREATEST(cache.next_attempt_at,
      clock_timestamp()+LEAST(60,5*power(2,LEAST(cache.failure_count,4))) * interval '1 minute')
  FROM jsonb_to_recordset(NEW.detail_targets) AS target(id text,generation uuid)
  WHERE cache.tenant_id=NEW.tenant_id AND cache.principal_id=NEW.principal_id
    AND cache.token_mode=NEW.token_mode AND cache.native_id=target.id AND cache.generation=target.generation
    AND (cache.read_started_at IS NULL OR cache.read_started_at<=COALESCE(NEW.attempted_at,NEW.created_at));
  RETURN NEW;
END $$;
CREATE TRIGGER backoff_package_detail_job AFTER UPDATE OF status ON package_refresh_jobs
  FOR EACH ROW WHEN (NEW.auto_details AND NEW.status IN ('failed','cancelled') AND OLD.status IS DISTINCT FROM NEW.status
    AND NEW.error_code IS DISTINCT FROM 'package_detail_read_failed')
  EXECUTE FUNCTION backoff_package_detail_job();

CREATE FUNCTION clear_admitted_package_details() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('package-refresh:'||NEW.tenant_id||':'||NEW.principal_id,0));
  DELETE FROM public.package_detail_cache WHERE tenant_id=NEW.tenant_id AND principal_id=NEW.principal_id;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION clear_admitted_package_details() FROM PUBLIC;
CREATE TRIGGER clear_admitted_package_details AFTER INSERT ON data_sync_runs
  FOR EACH ROW WHEN (NEW.clear_saved_data) EXECUTE FUNCTION clear_admitted_package_details();

DO $grants$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agentcontrol_app') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON package_detail_cache TO agentcontrol_app;
    GRANT EXECUTE ON FUNCTION package_detail_revision(jsonb),package_detail_has_evidence(jsonb),
      package_detail_current_catalog(text,text,text) TO agentcontrol_app;
  END IF;
END $grants$;
`;

export async function verifyPackageEnrichmentSchema(database: Pick<pg.Pool, "query">) {
  const contract = (await database.query<{ present: boolean; triggers: number; columns: number }>(`
    SELECT to_regclass('public.package_detail_cache') IS NOT NULL
      AND to_regprocedure('public.package_detail_revision(jsonb)') IS NOT NULL
      AND to_regprocedure('public.package_detail_has_evidence(jsonb)') IS NOT NULL
      AND to_regprocedure('public.package_detail_current_catalog(text,text,text)') IS NOT NULL AS present,
      (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND tgenabled IN ('O','A') AND (
        (tgrelid=to_regclass('public.package_refresh_jobs') AND tgname IN ('reconcile_package_detail_cache','backoff_package_detail_job'))
        OR (tgrelid=to_regclass('public.data_sync_runs') AND tgname='clear_admitted_package_details')
      )) AS triggers,
      (SELECT count(*)::int FROM pg_attribute WHERE NOT attisdropped AND (
        (attrelid=to_regclass('public.package_refresh_jobs') AND attname IN ('catalog_only','auto_details','detail_targets'))
        OR (attrelid=to_regclass('public.package_inventory_snapshots') AND attname='catalog_only')
      )) AS columns`)).rows[0];
  if (!contract?.present || contract.triggers !== 3 || contract.columns !== 4) {
    throw new Error("Package detail enrichment schema is missing or incomplete; operator migration required.");
  }
  const permissions = (await database.query<{ valid: boolean }>(`
    SELECT current_user<>'agentcontrol_app' OR (
      has_table_privilege(current_user,'package_detail_cache','SELECT')
      AND has_table_privilege(current_user,'package_detail_cache','INSERT')
      AND has_table_privilege(current_user,'package_detail_cache','UPDATE')
      AND has_table_privilege(current_user,'package_detail_cache','DELETE')
      AND NOT has_table_privilege(current_user,'package_detail_cache','TRUNCATE')
      AND has_function_privilege(current_user,'package_detail_revision(jsonb)','EXECUTE')
      AND has_function_privilege(current_user,'package_detail_has_evidence(jsonb)','EXECUTE')
      AND has_function_privilege(current_user,'package_detail_current_catalog(text,text,text)','EXECUTE')
    ) AS valid`)).rows[0];
  if (!permissions?.valid) throw new Error("Package detail enrichment runtime grants are invalid; operator recovery required.");
}
