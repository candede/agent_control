export const unifiedAgentRegistryMigrationSql = `
CREATE UNIQUE INDEX power_platform_inventory_resources_normalized_identity
  ON power_platform_inventory_resources(snapshot_id,resource_type,lower(environment_id),
    (CASE WHEN length(native_id)=36 AND native_id ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
      THEN lower(native_id) ELSE native_id END));

ALTER TABLE package_inventory_resources DROP CONSTRAINT package_inventory_resources_package_data_check;
ALTER TABLE package_inventory_resources ADD CONSTRAINT package_inventory_resources_package_data_check
  CHECK (jsonb_typeof(package_data)='object' AND octet_length(package_data::text) <= 2097152);

ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_state;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_check CHECK (action IN (
  'block','unblock','update-availability','update-installation','reassign','view-audit-search','export-audit-search',
  'view-hunting','export-hunting','approve-hunting','qualify-hunting','submit-hunting','query-hunting','cancel-hunting','delete-hunting',
  'revoke-hunting-scope','export-package-inventory','export-power-platform-inventory',
  'export-official-usage-aggregate','export-official-usage-users','export-administrative-audit','export-agent-inventory'));
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_state CHECK (
  (action IN ('block','unblock') AND target_blocked_state IS NOT NULL)
  OR (action NOT IN ('block','unblock') AND target_blocked_state IS NULL));

CREATE TABLE unified_agents (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  principal_id text NOT NULL CHECK (length(principal_id) BETWEEN 1 AND 256),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,tenant_id,principal_id)
);
CREATE INDEX unified_agents_scope ON unified_agents(tenant_id,principal_id,created_at,id);

CREATE TABLE unified_agent_sources (
  tenant_id text NOT NULL,
  principal_id text NOT NULL,
  agent_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('graph_packages','power_platform')),
  environment_id text NOT NULL CHECK (length(environment_id) <= 512),
  native_id text NOT NULL CHECK (length(native_id) BETWEEN 1 AND 512),
  normalized_environment_id text GENERATED ALWAYS AS (
    CASE WHEN source='power_platform' THEN lower(environment_id) ELSE environment_id END
  ) STORED,
  normalized_native_id text GENERATED ALWAYS AS (
    CASE WHEN source='power_platform' AND length(native_id)=36 AND native_id ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
      THEN lower(native_id) ELSE native_id END
  ) STORED,
  package_snapshot_id uuid,
  power_platform_snapshot_id uuid,
  power_platform_resource_type text GENERATED ALWAYS AS (
    CASE WHEN source='power_platform' THEN 'microsoft.copilotstudio/agents'::text ELSE NULL::text END
  ) STORED,
  matching_evidence jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(matching_evidence)='array' AND octet_length(matching_evidence::text) <= 16384
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,principal_id,source,environment_id,native_id),
  CONSTRAINT unified_agent_source_observation CHECK (
    (source='graph_packages' AND environment_id='' AND package_snapshot_id IS NOT NULL AND power_platform_snapshot_id IS NULL)
    OR (source='power_platform' AND package_snapshot_id IS NULL AND power_platform_snapshot_id IS NOT NULL AND matching_evidence='[]'::jsonb)
  ),
  FOREIGN KEY(agent_id,tenant_id,principal_id) REFERENCES unified_agents(id,tenant_id,principal_id) ON DELETE CASCADE,
  FOREIGN KEY(package_snapshot_id,tenant_id,principal_id)
    REFERENCES package_inventory_snapshots(id,tenant_id,principal_id) ON DELETE CASCADE,
  FOREIGN KEY(power_platform_snapshot_id,tenant_id,principal_id)
    REFERENCES power_platform_inventory_snapshots(id,tenant_id,principal_id) ON DELETE CASCADE,
  FOREIGN KEY(package_snapshot_id,native_id)
    REFERENCES package_inventory_resources(snapshot_id,native_id) ON DELETE CASCADE,
  FOREIGN KEY(power_platform_snapshot_id,power_platform_resource_type,environment_id,native_id)
    REFERENCES power_platform_inventory_resources(snapshot_id,resource_type,environment_id,native_id) ON DELETE CASCADE,
  CONSTRAINT unified_agent_one_power_platform
    UNIQUE(tenant_id,principal_id,agent_id,power_platform_resource_type) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX unified_agent_sources_normalized_identity
  ON unified_agent_sources(tenant_id,principal_id,source,normalized_environment_id,normalized_native_id);
CREATE INDEX unified_agent_sources_package_snapshot
  ON unified_agent_sources(package_snapshot_id,native_id) WHERE package_snapshot_id IS NOT NULL;
CREATE INDEX unified_agent_sources_power_platform_snapshot
  ON unified_agent_sources(power_platform_snapshot_id,power_platform_resource_type,environment_id,native_id)
  WHERE power_platform_snapshot_id IS NOT NULL;

CREATE FUNCTION lock_unified_agent_publication(p_tenant text,p_principal text,p_source text) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF p_source='graph_packages' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('package-refresh:'||p_tenant||':'||p_principal,0));
  ELSIF p_source='power_platform' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('power-platform:'||p_tenant||':'||p_principal,0));
  ELSE
    RAISE EXCEPTION 'unknown unified agent publication source';
  END IF;
  -- A PP publisher already owns its source lock: never acquire the package lock from that transaction.
  PERFORM pg_advisory_xact_lock(hashtextextended('unified-agent-publication:'||p_tenant||':'||p_principal,0));
  PERFORM id FROM public.unified_agents
    WHERE tenant_id=p_tenant AND principal_id=p_principal ORDER BY id FOR UPDATE;
END $$;

CREATE FUNCTION unified_agent_package_publication_targets(p_tenant text,p_principal text)
RETURNS TABLE(native_id text,snapshot_id uuid)
LANGUAGE sql VOLATILE SET search_path=pg_catalog,public,pg_temp AS $$
  WITH base AS (
    SELECT id,observed_at FROM public.package_inventory_snapshots
    WHERE tenant_id=p_tenant AND principal_id=p_principal AND token_mode='delegated' AND scope_kind='broad'
      AND is_current AND expires_at>clock_timestamp()
    ORDER BY observed_at DESC,id DESC LIMIT 1
  ), exact_targets AS (
    SELECT DISTINCT ON (target.native_id) target.native_id,snapshot.id,snapshot.observed_at
    FROM public.package_inventory_snapshots snapshot
    CROSS JOIN LATERAL jsonb_array_elements_text(snapshot.requested_ids) target(native_id)
    WHERE snapshot.tenant_id=p_tenant AND snapshot.principal_id=p_principal AND snapshot.token_mode='delegated'
      AND snapshot.scope_kind='exact' AND snapshot.is_current AND snapshot.expires_at>clock_timestamp()
    ORDER BY target.native_id,snapshot.observed_at DESC,snapshot.id DESC
  )
  SELECT membership.native_id,
    -- The source reader compares JavaScript Dates, then UUIDs, when choosing an exact overlay.
    CASE WHEN (date_trunc('milliseconds',exact_targets.observed_at),exact_targets.id)
      >(date_trunc('milliseconds',base.observed_at),base.id)
      THEN exact_targets.id ELSE base.id END
  FROM public.unified_agent_sources membership CROSS JOIN base
  LEFT JOIN exact_targets ON exact_targets.native_id=membership.native_id
  WHERE membership.tenant_id=p_tenant AND membership.principal_id=p_principal AND membership.source='graph_packages'
$$;

CREATE FUNCTION unified_agent_power_platform_publication_snapshot(p_tenant text,p_principal text) RETURNS uuid
LANGUAGE sql VOLATILE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT id FROM public.power_platform_inventory_snapshots
  WHERE tenant_id=p_tenant AND principal_id=p_principal AND is_current AND expires_at>clock_timestamp()
    AND requested_types @> '["microsoft.copilotstudio/agents"]'::jsonb
  ORDER BY CASE WHEN environment_scope='' THEN 1 ELSE 0 END DESC,observed_at DESC,id DESC LIMIT 1
$$;

CREATE FUNCTION prepare_unified_agent_source_publication() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NOT NEW.is_current OR NEW.expires_at<=clock_timestamp() THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='package_inventory_snapshots' THEN
    IF NEW.token_mode<>'delegated' THEN RETURN NEW; END IF;
    PERFORM public.lock_unified_agent_publication(NEW.tenant_id,NEW.principal_id,'graph_packages');
    WITH cleared AS (
      UPDATE public.unified_agent_sources membership SET matching_evidence='[]'::jsonb,updated_at=clock_timestamp()
      FROM public.unified_agent_package_publication_targets(NEW.tenant_id,NEW.principal_id) target
      WHERE membership.tenant_id=NEW.tenant_id AND membership.principal_id=NEW.principal_id
        AND membership.source='graph_packages' AND membership.native_id=target.native_id
        AND target.snapshot_id=NEW.id AND membership.matching_evidence<>'[]'::jsonb
      RETURNING membership.agent_id
    )
    UPDATE public.unified_agents SET updated_at=clock_timestamp()
      WHERE tenant_id=NEW.tenant_id AND principal_id=NEW.principal_id AND id IN (SELECT agent_id FROM cleared);
  ELSIF TG_TABLE_NAME='power_platform_inventory_snapshots' THEN
    IF NOT NEW.requested_types @> '["microsoft.copilotstudio/agents"]'::jsonb THEN RETURN NEW; END IF;
    PERFORM public.lock_unified_agent_publication(NEW.tenant_id,NEW.principal_id,'power_platform');
    IF NEW.id=public.unified_agent_power_platform_publication_snapshot(NEW.tenant_id,NEW.principal_id) THEN
      WITH cleared AS (
        UPDATE public.unified_agent_sources membership SET matching_evidence='[]'::jsonb,updated_at=clock_timestamp()
        WHERE membership.tenant_id=NEW.tenant_id AND membership.principal_id=NEW.principal_id
          AND membership.source='graph_packages' AND membership.matching_evidence<>'[]'::jsonb
          AND EXISTS (
            SELECT 1 FROM public.unified_agent_sources native
            WHERE native.tenant_id=membership.tenant_id AND native.principal_id=membership.principal_id
              AND native.agent_id=membership.agent_id AND native.source='power_platform')
        RETURNING membership.agent_id
      )
      UPDATE public.unified_agents SET updated_at=clock_timestamp()
        WHERE tenant_id=NEW.tenant_id AND principal_id=NEW.principal_id AND id IN (SELECT agent_id FROM cleared);
    END IF;
  ELSE
    RAISE EXCEPTION 'unknown unified agent snapshot table';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION advance_unified_agent_package_sources() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE publication record;
BEGIN
  FOR publication IN
    SELECT DISTINCT snapshot.tenant_id,snapshot.principal_id
    FROM inserted_unified_package_resources resource
    JOIN public.package_inventory_snapshots snapshot ON snapshot.id=resource.snapshot_id
    WHERE snapshot.token_mode='delegated' AND snapshot.is_current AND snapshot.expires_at>clock_timestamp()
    ORDER BY snapshot.tenant_id,snapshot.principal_id
  LOOP
    PERFORM public.lock_unified_agent_publication(publication.tenant_id,publication.principal_id,'graph_packages');
    WITH moved AS (
      UPDATE public.unified_agent_sources membership
      SET package_snapshot_id=resource.snapshot_id,matching_evidence='[]'::jsonb,updated_at=clock_timestamp()
      FROM inserted_unified_package_resources resource
      JOIN public.unified_agent_package_publication_targets(publication.tenant_id,publication.principal_id) target
        ON target.native_id=resource.native_id AND target.snapshot_id=resource.snapshot_id
      WHERE membership.tenant_id=publication.tenant_id AND membership.principal_id=publication.principal_id
        AND resource.tenant_id=membership.tenant_id AND resource.principal_id=membership.principal_id
        AND membership.source='graph_packages' AND membership.native_id=resource.native_id
        AND membership.package_snapshot_id IS DISTINCT FROM resource.snapshot_id
      RETURNING membership.agent_id
    )
    UPDATE public.unified_agents SET updated_at=clock_timestamp()
      WHERE tenant_id=publication.tenant_id AND principal_id=publication.principal_id AND id IN (SELECT agent_id FROM moved);
  END LOOP;
  RETURN NULL;
END $$;

CREATE FUNCTION advance_unified_agent_power_platform_sources() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE publication record; selected_snapshot uuid;
BEGIN
  FOR publication IN
    SELECT DISTINCT snapshot.tenant_id,snapshot.principal_id
    FROM inserted_unified_power_platform_resources resource
    JOIN public.power_platform_inventory_snapshots snapshot ON snapshot.id=resource.snapshot_id
    WHERE resource.resource_type='microsoft.copilotstudio/agents' AND snapshot.is_current
      AND snapshot.expires_at>clock_timestamp() AND snapshot.requested_types @> '["microsoft.copilotstudio/agents"]'::jsonb
    ORDER BY snapshot.tenant_id,snapshot.principal_id
  LOOP
    PERFORM public.lock_unified_agent_publication(publication.tenant_id,publication.principal_id,'power_platform');
    selected_snapshot := public.unified_agent_power_platform_publication_snapshot(publication.tenant_id,publication.principal_id);
    WITH moved AS (
      UPDATE public.unified_agent_sources membership
      SET power_platform_snapshot_id=resource.snapshot_id,environment_id=resource.environment_id,
        native_id=resource.native_id,matching_evidence='[]'::jsonb,updated_at=clock_timestamp()
      FROM inserted_unified_power_platform_resources resource
      WHERE membership.tenant_id=publication.tenant_id AND membership.principal_id=publication.principal_id
        AND resource.tenant_id=membership.tenant_id AND resource.principal_id=membership.principal_id
        AND membership.source='power_platform' AND resource.resource_type=membership.power_platform_resource_type
        AND membership.normalized_environment_id=lower(resource.environment_id)
        AND membership.normalized_native_id=CASE
          WHEN length(resource.native_id)=36 AND resource.native_id ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
            THEN lower(resource.native_id) ELSE resource.native_id END
        AND resource.snapshot_id=selected_snapshot
        AND (membership.power_platform_snapshot_id,membership.environment_id,membership.native_id)
          IS DISTINCT FROM (resource.snapshot_id,resource.environment_id,resource.native_id)
      RETURNING membership.agent_id
    ), cleared AS (
      UPDATE public.unified_agent_sources membership SET matching_evidence='[]'::jsonb,updated_at=clock_timestamp()
      WHERE tenant_id=publication.tenant_id AND principal_id=publication.principal_id AND source='graph_packages'
        AND agent_id IN (SELECT agent_id FROM moved) AND matching_evidence<>'[]'::jsonb
      RETURNING agent_id
    )
    UPDATE public.unified_agents SET updated_at=clock_timestamp()
      WHERE tenant_id=publication.tenant_id AND principal_id=publication.principal_id
        AND id IN (SELECT agent_id FROM moved UNION SELECT agent_id FROM cleared);
  END LOOP;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION lock_unified_agent_publication(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION unified_agent_package_publication_targets(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION unified_agent_power_platform_publication_snapshot(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION prepare_unified_agent_source_publication() FROM PUBLIC;
REVOKE ALL ON FUNCTION advance_unified_agent_package_sources() FROM PUBLIC;
REVOKE ALL ON FUNCTION advance_unified_agent_power_platform_sources() FROM PUBLIC;
CREATE TRIGGER prepare_unified_agent_package_publication AFTER INSERT ON package_inventory_snapshots
  FOR EACH ROW EXECUTE FUNCTION prepare_unified_agent_source_publication();
CREATE TRIGGER prepare_unified_agent_power_platform_publication AFTER INSERT ON power_platform_inventory_snapshots
  FOR EACH ROW EXECUTE FUNCTION prepare_unified_agent_source_publication();
CREATE TRIGGER advance_unified_agent_package_sources AFTER INSERT ON package_inventory_resources
  REFERENCING NEW TABLE AS inserted_unified_package_resources
  FOR EACH STATEMENT EXECUTE FUNCTION advance_unified_agent_package_sources();
CREATE TRIGGER advance_unified_agent_power_platform_sources AFTER INSERT ON power_platform_inventory_resources
  REFERENCING NEW TABLE AS inserted_unified_power_platform_resources
  FOR EACH STATEMENT EXECUTE FUNCTION advance_unified_agent_power_platform_sources();

CREATE FUNCTION clear_admitted_unified_agent_registry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('data-sync:'||NEW.tenant_id||':'||NEW.principal_id,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('package-refresh:'||NEW.tenant_id||':'||NEW.principal_id,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('power-platform:'||NEW.tenant_id||':'||NEW.principal_id,0));
  DELETE FROM public.unified_agents WHERE tenant_id=NEW.tenant_id AND principal_id=NEW.principal_id;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION clear_admitted_unified_agent_registry() FROM PUBLIC;
CREATE TRIGGER clear_admitted_unified_agent_registry
  AFTER INSERT ON data_sync_runs
  FOR EACH ROW WHEN (NEW.clear_saved_data)
  EXECUTE FUNCTION clear_admitted_unified_agent_registry();
`;
