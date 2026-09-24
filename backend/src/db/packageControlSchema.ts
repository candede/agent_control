export const packageControlMigrationSql = `
ALTER TABLE package_inventory_snapshots
  ADD COLUMN observation_kind text NOT NULL DEFAULT 'inventory',
  ADD COLUMN control_state jsonb,
  ADD COLUMN identity_revalidation_required boolean NOT NULL DEFAULT false,
  ADD COLUMN read_started_at timestamptz;
UPDATE package_inventory_snapshots snapshot
SET read_started_at=COALESCE(job.attempted_at,snapshot.observed_at)
FROM package_refresh_jobs job WHERE job.id=snapshot.job_id;
UPDATE package_inventory_snapshots SET read_started_at=observed_at WHERE read_started_at IS NULL;
ALTER TABLE package_inventory_snapshots
  ALTER COLUMN read_started_at SET NOT NULL,
  ALTER COLUMN read_started_at SET DEFAULT clock_timestamp();

-- Only audit-backed mutation receipts are reclassified; an orphaned refresh is not a control observation.
UPDATE package_inventory_snapshots snapshot
SET observation_kind=item.poststate->>'kind',control_state=item.poststate,
    query_hash=encode(sha256(convert_to('legacy-package-control:'||snapshot.id::text,'UTF8')),'hex')
FROM audit_events audit,job_items item,jobs job,package_inventory_resources resource
WHERE audit.metadata->>'snapshotId'=snapshot.id::text
  AND audit.tenant_id=snapshot.tenant_id AND audit.principal_id=snapshot.principal_id
  AND audit.status IN ('succeeded','skipped','inconclusive') AND audit.metadata->>'verification'='provider_readback'
  AND split_part(audit.event_id,':',1)=item.id::text AND item.job_id=job.id
  AND job.tenant_id=snapshot.tenant_id AND job.principal_id=snapshot.principal_id
  AND item.target_id=audit.agent_id AND resource.native_id=item.target_id
  AND resource.snapshot_id=snapshot.id AND resource.tenant_id=snapshot.tenant_id
  AND resource.principal_id=snapshot.principal_id
  AND snapshot.job_id IS NULL AND snapshot.token_mode='delegated'
  AND snapshot.scope_kind='exact' AND jsonb_array_length(snapshot.requested_ids)=1
  AND snapshot.requested_ids ? item.target_id AND snapshot.observed_count=1
  AND ((job.action IN ('block','unblock') AND item.poststate->>'kind'='block'
        AND item.poststate->'isBlocked'=resource.package_data->'isBlocked')
    OR (job.action IN ('update-availability','update-installation') AND item.poststate->>'kind'='access'));

UPDATE package_inventory_snapshots
SET expires_at=LEAST(expires_at,read_started_at+interval '30 days');
ALTER TABLE package_inventory_snapshots ADD CONSTRAINT package_observation_kind CHECK (
  (observation_kind='inventory' AND control_state IS NULL) OR
  (observation_kind IN ('block','access') AND control_state IS NOT NULL
    AND jsonb_typeof(control_state)='object' AND control_state ? 'kind' AND control_state->>'kind'=observation_kind
    AND token_mode='delegated' AND scope_kind='exact' AND jsonb_array_length(requested_ids)=1
    AND observed_count=1 AND total_records=1 AND page_count=1)
);
CREATE INDEX package_control_observations ON package_inventory_snapshots(
  tenant_id,principal_id,observation_kind,observed_at DESC
) WHERE is_current AND observation_kind<>'inventory';

CREATE OR REPLACE FUNCTION unified_agent_package_publication_targets(p_tenant text,p_principal text)
RETURNS TABLE(native_id text,snapshot_id uuid)
LANGUAGE sql VOLATILE SET search_path=pg_catalog,public,pg_temp AS $$
  WITH base AS (
    SELECT id,read_started_at FROM public.package_inventory_snapshots
    WHERE tenant_id=p_tenant AND principal_id=p_principal AND token_mode='delegated' AND scope_kind='broad'
      AND observation_kind='inventory' AND is_current AND expires_at>clock_timestamp()
    ORDER BY observed_at DESC,id DESC LIMIT 1
  ), exact_targets AS (
    SELECT DISTINCT ON (target.native_id) target.native_id,snapshot.id,snapshot.read_started_at
    FROM public.package_inventory_snapshots snapshot
    CROSS JOIN LATERAL jsonb_array_elements_text(snapshot.requested_ids) target(native_id)
    WHERE snapshot.tenant_id=p_tenant AND snapshot.principal_id=p_principal AND snapshot.token_mode='delegated'
      AND snapshot.observation_kind='inventory' AND snapshot.scope_kind='exact'
      AND snapshot.is_current AND snapshot.expires_at>clock_timestamp()
    ORDER BY target.native_id,date_trunc('milliseconds',snapshot.read_started_at) DESC,snapshot.id DESC
  )
  SELECT membership.native_id,
    CASE WHEN resource.native_id IS NULL AND control.id IS NOT NULL
      AND date_trunc('milliseconds',control.observed_at)>=date_trunc('milliseconds',target.read_started_at)
      THEN control.id ELSE target.id END
  FROM public.unified_agent_sources membership CROSS JOIN base
  LEFT JOIN exact_targets ON exact_targets.native_id=membership.native_id
  CROSS JOIN LATERAL (
    SELECT CASE WHEN (date_trunc('milliseconds',exact_targets.read_started_at),exact_targets.id)
        >(date_trunc('milliseconds',base.read_started_at),base.id) THEN exact_targets.id ELSE base.id END AS id,
      CASE WHEN (date_trunc('milliseconds',exact_targets.read_started_at),exact_targets.id)
        >(date_trunc('milliseconds',base.read_started_at),base.id) THEN exact_targets.read_started_at ELSE base.read_started_at END AS read_started_at
  ) target
  LEFT JOIN public.package_inventory_resources resource ON resource.snapshot_id=target.id
    AND resource.tenant_id=p_tenant AND resource.principal_id=p_principal AND resource.native_id=membership.native_id
  LEFT JOIN LATERAL (
    SELECT id,observed_at FROM public.package_inventory_snapshots
    WHERE tenant_id=p_tenant AND principal_id=p_principal AND token_mode='delegated'
      AND observation_kind IN ('block','access') AND requested_ids ? membership.native_id
      AND is_current AND expires_at>clock_timestamp()
    ORDER BY observed_at DESC,id DESC LIMIT 1
  ) control ON true
  WHERE membership.tenant_id=p_tenant AND membership.principal_id=p_principal AND membership.source='graph_packages'
$$;
`;
