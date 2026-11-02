import type pg from "pg";

export const officeAppAdoptionSchemaSql = String.raw`
CREATE TABLE office_observations (
  generation_id uuid PRIMARY KEY,
  scope_id uuid NOT NULL,
  tenant_id text NOT NULL,
  report_refresh_date date NOT NULL,
  period text NOT NULL CHECK (period='D28'),
  report_version text NOT NULL CHECK (report_version='v2'),
  kind text NOT NULL CHECK (kind IN ('current','weekly')),
  metrics jsonb NOT NULL CHECK (jsonb_typeof(metrics)='object' AND octet_length(metrics::text)<=8192),
  directory_generation_id uuid NOT NULL,
  app_generation_id uuid NOT NULL,
  directory_observed_at timestamptz NOT NULL,
  app_observed_at timestamptz NOT NULL,
  coverage jsonb NOT NULL CHECK (jsonb_typeof(coverage)='object' AND octet_length(coverage::text)<=8192),
  UNIQUE(generation_id,scope_id,tenant_id),
  FOREIGN KEY(generation_id,scope_id,tenant_id) REFERENCES data_generations(id,scope_id,tenant_id)
);
CREATE INDEX office_observation_chronology ON office_observations(tenant_id,report_refresh_date DESC,generation_id);
CREATE INDEX office_observation_source_lease ON office_observations(directory_generation_id,app_generation_id);
CREATE TABLE office_group_facts (
  generation_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  tenant_id text NOT NULL,
  group_id text NOT NULL CHECK (group_id~'^[a-f0-9]{64}$'),
  company text,
  department text,
  metrics jsonb NOT NULL CHECK (jsonb_typeof(metrics)='object' AND octet_length(metrics::text)<=8192),
  PRIMARY KEY(generation_id,group_id),
  FOREIGN KEY(generation_id,scope_id,tenant_id) REFERENCES office_observations(generation_id,scope_id,tenant_id)
);
CREATE TABLE office_person_facts (
  generation_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  tenant_id text NOT NULL,
  identity text NOT NULL CHECK (length(identity) BETWEEN 1 AND 512),
  payload jsonb NOT NULL CHECK ((jsonb_typeof(payload)='object' AND octet_length(payload::text)<=32768
    AND payload->>'identity'=identity AND payload->>'entitlement' IN ('paid_active','paid_inactive','no_paid','unknown')
    AND jsonb_typeof(payload->'dates')='object'
    AND (payload->'dates') ?& ARRAY['word','excel','powerpoint','outlook','onenote','loop','teams']
    AND (payload->'dates')-ARRAY['word','excel','powerpoint','outlook','onenote','loop','teams']='{}'::jsonb
    AND jsonb_typeof(payload->'recentApps')='array' AND jsonb_array_length(payload->'recentApps')<=7
    AND payload->'recentApps' <@ '["word","excel","powerpoint","outlook","onenote","loop","teams"]'::jsonb
    AND jsonb_typeof(payload->'unknownReasons')='array'
    AND payload->'unknownReasons' <@ '["missing_row","ambiguous_identity","retained_row","retained_directory","wrong_window","no_app_dates","invalid_app_date","future_app_date"]'::jsonb
    AND payload->>'groupId'~'^[a-f0-9]{64}$'
    AND payload->>'userPrincipalName' IS NOT NULL) IS TRUE),
  PRIMARY KEY(generation_id,identity),
  FOREIGN KEY(generation_id,scope_id,tenant_id) REFERENCES office_observations(generation_id,scope_id,tenant_id)
);
CREATE INDEX office_person_group ON office_person_facts(generation_id,(payload->>'groupId'),
  (normalize(lower(normalize(coalesce(nullif(btrim(payload->>'displayName'),''),payload->>'userPrincipalName'),NFKC)
    COLLATE "default"),NFKC) COLLATE "C"),identity COLLATE "C")
  WHERE payload->>'entitlement'='paid_active';
CREATE FUNCTION office_evidence_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path TO pg_catalog,public AS $$
DECLARE generation record;
BEGIN
  IF TG_OP='INSERT' AND TG_LEVEL='STATEMENT' THEN
    IF TG_TABLE_NAME='office_person_facts' AND EXISTS(
      SELECT 1 FROM office_inserted_facts inserted JOIN public.office_observations observation
        ON observation.generation_id=inserted.generation_id WHERE observation.kind<>'current')
      THEN RAISE EXCEPTION 'Historical Office snapshots contain aggregates only'; END IF;
    FOR generation IN SELECT g.id,g.scope_id,g.tenant_id,g.state,g.lease_until,g.deadline_at,g.scope_epoch
      FROM public.data_generations g
      WHERE g.id IN (SELECT DISTINCT generation_id FROM office_inserted_facts)
      ORDER BY g.id FOR SHARE LOOP
      IF generation.state IS DISTINCT FROM 'staging'
        OR generation.lease_until<=clock_timestamp() OR generation.deadline_at<=clock_timestamp()
        OR NOT EXISTS(SELECT 1 FROM public.data_scope_epochs s WHERE s.id=generation.scope_id
          AND s.tenant_id=generation.tenant_id AND s.source IN ('office_app_adoption','office_history')
          AND s.scope_kind='tenant' AND s.epoch=generation.scope_epoch)
      THEN RAISE EXCEPTION 'Office evidence requires a fenced staging lease'; END IF;
    END LOOP;
    RETURN NULL;
  END IF;
  SELECT * INTO generation FROM public.data_generations
    WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.generation_id ELSE NEW.generation_id END FOR SHARE;
  IF TG_OP='INSERT' AND (generation.state IS DISTINCT FROM 'staging'
    OR generation.lease_until<=clock_timestamp() OR generation.deadline_at<=clock_timestamp()
    OR NOT EXISTS(SELECT 1 FROM public.data_scope_epochs s WHERE s.id=NEW.scope_id AND s.tenant_id=NEW.tenant_id
      AND s.source IN ('office_app_adoption','office_history') AND s.scope_kind='tenant' AND s.epoch=generation.scope_epoch))
  THEN RAISE EXCEPTION 'Office evidence requires a fenced staging lease'; END IF;
  IF TG_OP='INSERT' AND TG_TABLE_NAME='office_observations' THEN
    IF NOT EXISTS(SELECT 1 FROM public.data_scope_epochs scope WHERE scope.id=NEW.scope_id
      AND scope.source=CASE WHEN NEW.kind='current' THEN 'office_app_adoption' ELSE 'office_history' END
      AND scope.selector=CASE WHEN NEW.kind='current' THEN 'current'
        ELSE (date_trunc('week',NEW.report_refresh_date::timestamp)::date)::text||':D28:v2' END)
      THEN RAISE EXCEPTION 'Office canonical scope does not match the report window'; END IF;
  END IF;
  IF TG_OP='UPDATE' THEN
    IF TG_TABLE_NAME<>'office_observations' THEN RAISE EXCEPTION 'Office evidence is immutable'; END IF;
    IF (generation.state IS DISTINCT FROM 'staging'
    OR generation.lease_until<=clock_timestamp() OR generation.deadline_at<=clock_timestamp()
    OR to_jsonb(NEW)-ARRAY['coverage','metrics']<>to_jsonb(OLD)-ARRAY['coverage','metrics']
    OR OLD.coverage-ARRAY['reportedRows','retainedRows']<>'{}'::jsonb
    OR NEW.coverage->>'directoryPeople' IS NULL
    OR NOT EXISTS(SELECT 1 FROM public.data_scope_epochs s WHERE s.id=NEW.scope_id AND s.epoch=generation.scope_epoch))
      THEN RAISE EXCEPTION 'Office evidence is immutable'; END IF;
  END IF;
  IF TG_OP='DELETE' AND generation.state IS DISTINCT FROM 'deleting'
    THEN RAISE EXCEPTION 'Office evidence requires lifecycle deletion'; END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER office_observation_guard BEFORE INSERT OR UPDATE OR DELETE ON office_observations
  FOR EACH ROW EXECUTE FUNCTION office_evidence_guard();
CREATE TRIGGER office_person_guard BEFORE UPDATE OR DELETE ON office_person_facts
  FOR EACH ROW EXECUTE FUNCTION office_evidence_guard();
CREATE TRIGGER office_person_insert_guard AFTER INSERT ON office_person_facts
  REFERENCING NEW TABLE AS office_inserted_facts
  FOR EACH STATEMENT EXECUTE FUNCTION office_evidence_guard();
CREATE TRIGGER office_group_guard BEFORE UPDATE OR DELETE ON office_group_facts
  FOR EACH ROW EXECUTE FUNCTION office_evidence_guard();
CREATE TRIGGER office_group_insert_guard AFTER INSERT ON office_group_facts
  REFERENCING NEW TABLE AS office_inserted_facts
  FOR EACH STATEMENT EXECUTE FUNCTION office_evidence_guard();
CREATE FUNCTION office_source_clear() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog,public AS $$
DECLARE office_scope record;
BEGIN
  IF NEW.epoch=OLD.epoch THEN RETURN NEW; END IF;
  FOR office_scope IN SELECT id FROM public.data_scope_epochs WHERE tenant_id=NEW.tenant_id
    AND source IN ('office_app_adoption','office_history') ORDER BY id FOR UPDATE LOOP
    UPDATE public.data_scope_epochs SET epoch=epoch+1 WHERE id=office_scope.id;
    UPDATE public.data_generations SET state='cancelled',cancellation=cancellation+1,reserved_bytes=byte_count
      WHERE scope_id=office_scope.id AND state IN ('staging','validating');
    UPDATE public.data_generations SET state='retired' WHERE scope_id=office_scope.id AND state='published';
    DELETE FROM public.data_generation_heads WHERE scope_id=office_scope.id;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER office_source_clear AFTER UPDATE OF epoch ON data_scope_epochs
  FOR EACH ROW WHEN (NEW.source IN ('directory','app_activity')) EXECUTE FUNCTION office_source_clear();
REVOKE ALL ON FUNCTION office_evidence_guard() FROM PUBLIC,agentcontrol_app;
REVOKE ALL ON FUNCTION office_source_clear() FROM PUBLIC,agentcontrol_app;
GRANT SELECT,INSERT,DELETE ON office_observations,office_person_facts,office_group_facts TO agentcontrol_app;
GRANT UPDATE(coverage,metrics) ON office_observations TO agentcontrol_app;
`;

export async function verifyOfficeAppAdoptionSchema(database: Pick<pg.Pool, "query">) {
  const functionBodies = ["office_evidence_guard", "office_source_clear"].map(name => {
    const body = officeAppAdoptionSchemaSql.match(new RegExp(`CREATE FUNCTION ${name}\\(\\)[\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`))?.[1];
    if (!body) throw new Error("office_app_adoption_schema");
    return body;
  });
  const row = (await database.query(`SELECT
    to_regclass('public.office_observations') IS NOT NULL AND to_regclass('public.office_person_facts') IS NOT NULL
    AND to_regclass('public.office_group_facts') IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM (VALUES
      ('public.office_observations','office_observation_guard',31,NULL),
      ('public.office_person_facts','office_person_guard',27,NULL),
      ('public.office_person_facts','office_person_insert_guard',4,'office_inserted_facts'),
      ('public.office_group_facts','office_group_guard',27,NULL),
      ('public.office_group_facts','office_group_insert_guard',4,'office_inserted_facts')
    ) expected(table_name,trigger_name,trigger_type,transition_rows) WHERE NOT EXISTS(
      SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass(expected.table_name)
        AND t.tgname=expected.trigger_name AND NOT t.tgisinternal AND t.tgenabled='O'
        AND t.tgtype=expected.trigger_type AND t.tgfoid=to_regprocedure('public.office_evidence_guard()')
        AND t.tgnewtable IS NOT DISTINCT FROM expected.transition_rows
        AND t.tgoldtable IS NULL AND t.tgqual IS NULL AND t.tgattr::text=''))
    AND EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_attribute epoch ON epoch.attrelid=t.tgrelid
      AND epoch.attname='epoch' AND NOT epoch.attisdropped
      WHERE t.tgrelid='public.data_scope_epochs'::regclass AND t.tgname='office_source_clear'
        AND NOT t.tgisinternal AND t.tgenabled='O' AND t.tgtype=17
        AND t.tgfoid=to_regprocedure('public.office_source_clear()')
        AND t.tgattr::text=epoch.attnum::text AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
        AND position('WHEN ((new.source = ANY (ARRAY[''directory''::text, ''app_activity''::text])))'
          IN pg_get_triggerdef(t.oid))>0)
    AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.office_evidence_guard()')
      AND p.prosrc=$1 AND NOT p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog, public']
      AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql')
      AND p.prorettype='trigger'::regtype AND p.provolatile='v' AND p.proparallel='u')
    AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.office_source_clear()')
      AND p.prosrc=$2 AND p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog, public']
      AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql')
      AND p.prorettype='trigger'::regtype AND p.provolatile='v' AND p.proparallel='u')
    AND NOT has_function_privilege('agentcontrol_app','public.office_evidence_guard()','EXECUTE')
    AND NOT has_function_privilege('agentcontrol_app','public.office_source_clear()','EXECUTE')
    AND NOT EXISTS(SELECT 1 FROM (VALUES
      ('public.office_observations','public.data_generations'),
      ('public.office_person_facts','public.office_observations'),
      ('public.office_group_facts','public.office_observations')
    ) expected(table_name,parent_table) WHERE NOT EXISTS(
      SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass(expected.table_name)
        AND c.confrelid=to_regclass(expected.parent_table) AND c.contype='f' AND c.convalidated
        AND c.conkey=ARRAY[1,2,3]::smallint[] AND c.confkey=ARRAY[1,2,3]::smallint[]
        AND c.confdeltype='a' AND c.confupdtype='a' AND c.confmatchtype='s'
        AND NOT c.condeferrable AND NOT c.condeferred))
    AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.data_generation_pins'::regclass
      AND conname='data_generation_pins_root_kind_check' AND contype='c' AND convalidated
      AND pg_get_constraintdef(oid) LIKE '%office_observation%')
    AND position('EXISTS(SELECT 1 FROM office_observations WHERE generation_id=NEW.id)'
      IN pg_get_functiondef('public.data_protect_generation()'::regprocedure))>0
    AND position('EXISTS(SELECT 1 FROM office_person_facts WHERE generation_id=NEW.id)'
      IN pg_get_functiondef('public.data_protect_generation()'::regprocedure))>0
    AND position('EXISTS(SELECT 1 FROM office_group_facts WHERE generation_id=NEW.id)'
      IN pg_get_functiondef('public.data_protect_generation()'::regprocedure))>0
    AND has_table_privilege('agentcontrol_app','public.office_observations','SELECT')
    AND has_table_privilege('agentcontrol_app','public.office_observations','INSERT')
    AND has_table_privilege('agentcontrol_app','public.office_observations','DELETE')
    AND has_table_privilege('agentcontrol_app','public.office_person_facts','SELECT')
    AND has_table_privilege('agentcontrol_app','public.office_person_facts','INSERT')
    AND has_table_privilege('agentcontrol_app','public.office_person_facts','DELETE')
    AND has_table_privilege('agentcontrol_app','public.office_group_facts','SELECT')
    AND has_table_privilege('agentcontrol_app','public.office_group_facts','INSERT')
    AND has_table_privilege('agentcontrol_app','public.office_group_facts','DELETE')
    AND has_column_privilege('agentcontrol_app','public.office_observations','coverage','UPDATE')
    AND has_column_privilege('agentcontrol_app','public.office_observations','metrics','UPDATE')
    AND NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='public.office_observations'::regclass
      AND a.attnum>0 AND NOT a.attisdropped AND a.attname NOT IN ('coverage','metrics')
      AND has_column_privilege('agentcontrol_app',a.attrelid,a.attnum,'UPDATE'))
    AND NOT has_any_column_privilege('agentcontrol_app','public.office_person_facts','UPDATE')
    AND NOT has_any_column_privilege('agentcontrol_app','public.office_group_facts','UPDATE')
    AND NOT has_table_privilege('agentcontrol_app','public.office_observations','UPDATE,TRUNCATE')
    AND NOT has_table_privilege('agentcontrol_app','public.office_person_facts','UPDATE,TRUNCATE')
    AND NOT has_table_privilege('agentcontrol_app','public.office_group_facts','UPDATE,TRUNCATE') AS valid`, functionBodies)).rows[0];
  if (row?.valid !== true) throw new Error("office_app_adoption_schema");
}
