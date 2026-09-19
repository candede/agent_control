export const agentUsageMigrationSql = `
CREATE TABLE agent_usage_state (
  tenant_id text PRIMARY KEY CHECK (length(tenant_id) BETWEEN 1 AND 128),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0)
);

CREATE TABLE agent_usage_associations (
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  report_set_id uuid NOT NULL,
  report_agent_id text NOT NULL CHECK (
    length(report_agent_id) BETWEEN 1 AND 512 AND report_agent_id !~ '[[:cntrl:]]'
  ),
  source text NOT NULL CHECK (source IN ('graph_packages','power_platform')),
  native_id text NOT NULL CHECK (length(native_id) BETWEEN 1 AND 512 AND native_id !~ '[[:cntrl:]]'),
  environment_id text NOT NULL CHECK (length(environment_id)<=512 AND environment_id !~ '[[:cntrl:]]'),
  normalized_environment_id text GENERATED ALWAYS AS (
    CASE WHEN source='power_platform' THEN lower(environment_id) ELSE environment_id END
  ) STORED,
  normalized_native_id text GENERATED ALWAYS AS (
    CASE WHEN source='power_platform' AND length(native_id)=36
      AND native_id ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
      THEN lower(native_id) ELSE native_id END
  ) STORED,
  basis text NOT NULL DEFAULT 'admin_reviewed' CHECK (basis='admin_reviewed'),
  reviewed_by text NOT NULL CHECK (length(reviewed_by) BETWEEN 1 AND 256),
  reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,report_set_id,report_agent_id),
  CHECK (source<>'graph_packages' OR environment_id=''),
  FOREIGN KEY(report_set_id,tenant_id) REFERENCES official_usage_sets(id,tenant_id) ON DELETE CASCADE
);
CREATE INDEX agent_usage_associations_target
  ON agent_usage_associations(tenant_id,report_set_id,source,normalized_environment_id,normalized_native_id);

CREATE FUNCTION protect_agent_usage_association() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'reviewed usage associations are immutable; remove before reassignment'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.official_usage_state state
    JOIN public.official_usage_sets report_set ON report_set.id=state.active_set_id AND report_set.tenant_id=state.tenant_id
    JOIN public.official_usage_set_versions membership ON membership.set_id=report_set.id
      AND membership.tenant_id=report_set.tenant_id AND membership.kind='agents'
    JOIN public.official_usage_versions version ON version.id=membership.version_id
      AND version.tenant_id=membership.tenant_id AND version.kind=membership.kind
    JOIN public.official_usage_artifacts artifact ON artifact.id=version.artifact_id
      AND artifact.tenant_id=version.tenant_id AND artifact.kind=version.kind
    JOIN public.official_usage_version_rows row ON row.version_id=version.id
      AND row.tenant_id=version.tenant_id AND row.kind=version.kind
    JOIN public.official_usage_row_facts fact ON fact.tenant_id=row.tenant_id
      AND fact.kind=row.kind AND fact.payload_hash=row.payload_hash
    WHERE state.tenant_id=NEW.tenant_id AND report_set.id=NEW.report_set_id
      AND report_set.complete AND report_set.deleted_at IS NULL
      AND (report_set.expires_at IS NULL OR report_set.expires_at>clock_timestamp())
      AND version.deleted_at IS NULL AND (version.expires_at IS NULL OR version.expires_at>clock_timestamp())
      AND (artifact.expires_at IS NULL OR artifact.expires_at>clock_timestamp())
      AND fact.row_data->>'agentId'=NEW.report_agent_id
  ) THEN RAISE EXCEPTION 'usage association requires an agent in the active accepted Agents export'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.unified_agent_sources membership
    LEFT JOIN public.package_inventory_snapshots package ON package.id=membership.package_snapshot_id
      AND package.tenant_id=membership.tenant_id AND package.principal_id=membership.principal_id
    LEFT JOIN public.power_platform_inventory_snapshots native ON native.id=membership.power_platform_snapshot_id
      AND native.tenant_id=membership.tenant_id AND native.principal_id=membership.principal_id
    WHERE membership.tenant_id=NEW.tenant_id AND membership.principal_id=NEW.reviewed_by
      AND membership.source=NEW.source
      AND membership.normalized_environment_id=CASE WHEN NEW.source='power_platform' THEN lower(NEW.environment_id) ELSE NEW.environment_id END
      AND membership.normalized_native_id=CASE WHEN NEW.source='power_platform' AND length(NEW.native_id)=36
        AND NEW.native_id ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN lower(NEW.native_id) ELSE NEW.native_id END
      AND ((NEW.source='graph_packages' AND package.is_current AND package.token_mode='delegated' AND package.expires_at>clock_timestamp())
        OR (NEW.source='power_platform' AND native.is_current AND native.expires_at>clock_timestamp()
          AND native.queried_types @> '["microsoft.copilotstudio/agents"]'::jsonb))
  ) THEN RAISE EXCEPTION 'usage association requires an authorized current native source'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_agent_usage_association BEFORE INSERT OR UPDATE ON agent_usage_associations
  FOR EACH ROW EXECUTE FUNCTION protect_agent_usage_association();

CREATE FUNCTION advance_agent_usage_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  INSERT INTO public.agent_usage_state(tenant_id,revision)
    VALUES(CASE WHEN TG_OP='DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END,1)
    ON CONFLICT(tenant_id) DO UPDATE SET revision=public.agent_usage_state.revision+1;
  RETURN NULL;
END $$;
CREATE TRIGGER advance_agent_usage_revision AFTER INSERT OR DELETE ON agent_usage_associations
  FOR EACH ROW EXECUTE FUNCTION advance_agent_usage_revision();

CREATE FUNCTION delete_agent_usage_report_associations() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  DELETE FROM public.agent_usage_associations WHERE tenant_id=NEW.tenant_id AND report_set_id=NEW.id;
  RETURN NULL;
END $$;
CREATE TRIGGER delete_agent_usage_report_associations AFTER UPDATE OF deleted_at ON official_usage_sets
  FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION delete_agent_usage_report_associations();

REVOKE ALL ON FUNCTION protect_agent_usage_association() FROM PUBLIC;
REVOKE ALL ON FUNCTION advance_agent_usage_revision() FROM PUBLIC;
REVOKE ALL ON FUNCTION delete_agent_usage_report_associations() FROM PUBLIC;

ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_check CHECK (action IN (
  'block','unblock','update-availability','update-installation','reassign','view-audit-search','export-audit-search',
  'view-hunting','export-hunting','approve-hunting','qualify-hunting','submit-hunting','query-hunting','cancel-hunting','delete-hunting',
  'revoke-hunting-scope','export-package-inventory','export-power-platform-inventory',
  'export-official-usage-aggregate','export-official-usage-users','export-administrative-audit','export-agent-inventory',
  'associate-agent-usage','remove-agent-usage-association'));
`;
