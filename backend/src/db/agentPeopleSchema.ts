export const agentPeopleMigrationSql = `
CREATE TABLE agent_people_cache (
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  principal_id text NOT NULL CHECK (length(principal_id) BETWEEN 1 AND 256),
  object_id uuid NOT NULL,
  revision uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('resolved','not_found','lookup_failed')),
  display_name text CHECK (length(display_name) BETWEEN 1 AND 512),
  user_principal_name text CHECK (length(user_principal_name) BETWEEN 1 AND 320),
  checked_at timestamptz NOT NULL,
  resolved_at timestamptz,
  expires_at timestamptz NOT NULL,
  error_code text CHECK (error_code ~ '^[a-z][a-z0-9_]{0,127}$'),
  PRIMARY KEY (tenant_id,principal_id,object_id),
  CHECK (expires_at>checked_at),
  CHECK ((status='lookup_failed')=(error_code IS NOT NULL)),
  CHECK (status<>'not_found' OR (display_name IS NULL AND user_principal_name IS NULL AND resolved_at IS NULL))
);
CREATE INDEX agent_people_cache_expiry ON agent_people_cache(expires_at);

CREATE FUNCTION clear_admitted_agent_people() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('data-sync:'||NEW.tenant_id||':'||NEW.principal_id,0));
  DELETE FROM public.agent_people_cache WHERE tenant_id=NEW.tenant_id AND principal_id=NEW.principal_id;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION clear_admitted_agent_people() FROM PUBLIC;
CREATE TRIGGER clear_admitted_agent_people
  AFTER INSERT ON data_sync_runs
  FOR EACH ROW WHEN (NEW.clear_saved_data)
  EXECUTE FUNCTION clear_admitted_agent_people();
`;
