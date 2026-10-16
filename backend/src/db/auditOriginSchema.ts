import type pg from "pg";
import { unknownOrigin } from "../types/actionOrigin.js";

export const auditOriginValidationSql = String.raw`
CREATE FUNCTION audit_origin_valid(origin jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path TO pg_catalog,public AS $$
DECLARE entry jsonb; label text; maximum integer; compact_bytes integer := 0;
BEGIN
  IF origin IS NULL OR jsonb_typeof(origin)<>'object'
    OR origin-ARRAY['version','channel','integrationClientId','client','callingAgent','requestId','mcpCallId']<>'{}'
    OR NOT origin ?& ARRAY['version','channel','integrationClientId','client','callingAgent','requestId','mcpCallId']
    OR origin->'version'<>'1' OR origin->>'channel' NOT IN ('unknown','webapp','mcp')
    OR jsonb_typeof(origin->'client')<>'object'
    OR (origin->'client')-ARRAY['id','name','version']<>'{}'
    OR NOT (origin->'client') ?& ARRAY['id','name','version']
    OR jsonb_typeof(origin->'callingAgent')<>'object'
    OR (origin->'callingAgent')-ARRAY['id','name']<>'{}'
    OR NOT (origin->'callingAgent') ?& ARRAY['id','name'] THEN RETURN false; END IF;
  IF origin->>'channel'='unknown' THEN RETURN origin='${JSON.stringify(unknownOrigin)}'::jsonb; END IF;
  IF jsonb_typeof(origin->'channel')<>'string' OR jsonb_typeof(origin->'integrationClientId')<>'string'
    OR origin->>'integrationClientId' !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
    OR jsonb_typeof(origin->'requestId') NOT IN ('string','null')
    OR origin->>'requestId' !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
    OR jsonb_typeof(origin->'mcpCallId') NOT IN ('string','null')
    OR origin->>'mcpCallId' !~ '^[A-Za-z0-9_.:-]{1,128}$' THEN RETURN false; END IF;
  FOR entry,maximum IN SELECT origin#>'{client,id}',256 UNION ALL SELECT origin#>'{client,name}',256
    UNION ALL SELECT origin#>'{client,version}',64 UNION ALL SELECT origin#>'{callingAgent,id}',256
    UNION ALL SELECT origin#>'{callingAgent,name}',256 LOOP
    IF jsonb_typeof(entry)<>'object' OR entry-ARRAY['value','evidence']<>'{}'
      OR NOT entry ?& ARRAY['value','evidence'] OR jsonb_typeof(entry->'evidence')<>'string' THEN RETURN false; END IF;
    IF entry->>'evidence'='unknown' THEN
      IF entry->'value'<>'null' THEN RETURN false; END IF;
    ELSE
      label := entry->>'value';
      IF entry->>'evidence' NOT IN ('authenticated','reported') OR jsonb_typeof(entry->'value')<>'string'
        OR length(label)<1 OR length(label)>maximum OR label ~ '[[:cntrl:]]'
        OR label ~ U&'[\00AD\0600-\0605\061C\06DD\070F\0890-\0891\08E2\180E\200B-\200F\202A-\202E\2060-\2064\2066-\206F\FEFF\FFF9-\FFFB\+0110BD\+0110CD\+013430-\+01343F\+01BCA0-\+01BCA3\+01D173-\+01D17A\+0E0001\+0E0020-\+0E007F]' THEN RETURN false; END IF;
    END IF;
    compact_bytes := compact_bytes + octet_length((entry->'value')::text) + octet_length((entry->'evidence')::text);
  END LOOP;
  -- Fixed compact JSON punctuation/keys plus each already JSON-escaped scalar.
  compact_bytes := compact_bytes + octet_length('{"version":1,"channel":,"integrationClientId":,"client":{"id":{"value":,"evidence":},"name":{"value":,"evidence":},"version":{"value":,"evidence":}},"callingAgent":{"id":{"value":,"evidence":},"name":{"value":,"evidence":}},"requestId":,"mcpCallId":}')
    + octet_length((origin->'channel')::text) + octet_length((origin->'integrationClientId')::text)
    + octet_length((origin->'requestId')::text) + octet_length((origin->'mcpCallId')::text);
  RETURN compact_bytes<=4096;
END $$;
`;

export const auditOriginIntegritySql = String.raw`
CREATE FUNCTION protect_action_origin() RETURNS trigger LANGUAGE plpgsql SET search_path TO pg_catalog,public AS $$
BEGIN
  IF TG_TABLE_NAME='inventory_mutation_stages' AND to_jsonb(OLD)->>'job_id' IS NOT NULL
    AND to_jsonb(NEW)->>'job_id' IS DISTINCT FROM to_jsonb(OLD)->>'job_id'
    THEN RAISE EXCEPTION 'action_origin_immutable'; END IF;
  IF TG_TABLE_NAME='defender_hunting_jobs' AND to_jsonb(NEW)->'initiating_actor' IS DISTINCT FROM to_jsonb(OLD)->'initiating_actor'
    THEN RAISE EXCEPTION 'action_actor_immutable'; END IF;
  IF NEW.origin IS DISTINCT FROM OLD.origin THEN
    IF TG_TABLE_NAME='inventory_mutation_stages' AND to_jsonb(OLD)->>'job_id' IS NULL
      AND to_jsonb(NEW)->>'job_id' IS NOT NULL AND OLD.origin='${JSON.stringify(unknownOrigin)}'::jsonb
      AND EXISTS(SELECT 1 FROM jobs j WHERE j.id=(to_jsonb(NEW)->>'job_id')::uuid
        AND j.tenant_id=NEW.tenant_id AND j.principal_id=NEW.principal_id AND j.origin=NEW.origin) THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'action_origin_immutable';
  END IF;
  RETURN NEW;
END $$;
${["jobs", "copilot_quarantine_jobs", "data_exports", "inventory_mutation_stages", "defender_hunting_jobs", "official_usage_ingestions"].map(table => `
CREATE TRIGGER protect_action_origin BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION protect_action_origin();
`).join("")}
CREATE FUNCTION protect_audit_event_origin() RETURNS trigger LANGUAGE plpgsql SET search_path TO pg_catalog,public AS $$
DECLARE prior audit_events;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('audit-origin:'||NEW.tenant_id||':'||NEW.principal_id||':'||NEW.event_id,0));
  SELECT * INTO prior FROM audit_events WHERE tenant_id=NEW.tenant_id AND principal_id=NEW.principal_id AND event_id=NEW.event_id LIMIT 1;
  IF FOUND AND (NEW.origin,NEW.actor_username,NEW.actor_name,NEW.operation_id,NEW.action,NEW.agent_id)
    IS DISTINCT FROM (prior.origin,prior.actor_username,prior.actor_name,prior.operation_id,prior.action,prior.agent_id)
    THEN RAISE EXCEPTION 'audit_event_origin_immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_audit_event_origin BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION protect_audit_event_origin();
CREATE INDEX audit_events_origin_channel ON audit_events(tenant_id,principal_id,(origin->>'channel'),started_at DESC,event_id);
CREATE INDEX copilot_quarantine_audit_origin_channel ON copilot_quarantine_audit(tenant_id,principal_id,(origin->>'channel'),observed_at DESC);
REVOKE ALL ON FUNCTION audit_origin_valid(jsonb),protect_action_origin(),protect_audit_event_origin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_origin_valid(jsonb) TO agentcontrol_app;
`;

export async function verifyAuditOriginSchema(database: Pick<pg.Pool, "query">) {
  const canonical = (await database.query<{ definition: string }>(
    "SELECT quote_literal($1::jsonb::text)||'::jsonb' AS definition", [JSON.stringify(unknownOrigin)])).rows[0].definition;
  const row = (await database.query<{ valid: boolean }>(`SELECT
    (SELECT count(*)=9 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid IN ('audit_events'::regclass,'official_usage_audit'::regclass,'jobs'::regclass,
        'inventory_mutation_stages'::regclass,'copilot_quarantine_jobs'::regclass,'copilot_quarantine_audit'::regclass,'data_exports'::regclass,
        'defender_hunting_jobs'::regclass,'official_usage_ingestions'::regclass)
      AND a.attname='origin' AND a.atttypid='jsonb'::regtype AND a.attnotnull AND NOT a.attisdropped
      AND pg_get_expr(d.adbin,d.adrelid)=$1)
    AND (SELECT count(*)=9 FROM pg_constraint WHERE conname IN ('audit_events_origin_check','official_usage_audit_origin_check',
      'jobs_origin_check','inventory_mutation_stages_origin_check','copilot_quarantine_jobs_origin_check',
      'copilot_quarantine_audit_origin_check','data_exports_origin_check','defender_hunting_jobs_origin_check','official_usage_ingestions_origin_check') AND convalidated
      AND conname=conrelid::regclass::text||'_origin_check' AND pg_get_expr(conbin,conrelid)='audit_origin_valid(origin)')
    AND EXISTS(SELECT 1 FROM pg_constraint WHERE conname='defender_hunting_jobs_initiating_actor_check' AND convalidated)
    AND (SELECT count(*)=7 FROM pg_trigger WHERE tgname IN ('protect_action_origin','protect_audit_event_origin')
      AND NOT tgisinternal AND tgenabled='O' AND (
        (tgname='protect_audit_event_origin' AND tgrelid='audit_events'::regclass
          AND tgfoid='protect_audit_event_origin()'::regprocedure AND tgtype=7)
        OR (tgname='protect_action_origin' AND tgrelid IN ('jobs'::regclass,'copilot_quarantine_jobs'::regclass,
          'data_exports'::regclass,'inventory_mutation_stages'::regclass,'defender_hunting_jobs'::regclass,'official_usage_ingestions'::regclass)
          AND tgfoid='protect_action_origin()'::regprocedure AND tgtype=19)))
    AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='audit_projection'::regclass AND attname='origin' AND atttypid='jsonb'::regtype)
    AND (SELECT count(*)=2 FROM pg_index WHERE indexrelid IN (to_regclass('audit_events_origin_channel'),
      to_regclass('copilot_quarantine_audit_origin_channel')) AND indisvalid AND indisready)
    AND has_function_privilege('agentcontrol_app','audit_origin_valid(jsonb)','EXECUTE')
    AND NOT has_table_privilege('agentcontrol_app','audit_events','UPDATE,DELETE,TRUNCATE')
    AND NOT has_table_privilege('agentcontrol_app','official_usage_audit','UPDATE,DELETE,TRUNCATE')
    AND NOT has_table_privilege('agentcontrol_app','copilot_quarantine_audit','UPDATE,DELETE,TRUNCATE')
    AND has_table_privilege('agentcontrol_app','audit_projection','SELECT') AS valid`,
  [canonical])).rows[0];
  if (row?.valid !== true) throw new Error("audit_origin_schema_invalid");
  const indexes = (await database.query<{ name: string; table: string; method: string; fields: (string | null)[]; options: string;
    expression: string; unique: boolean; keys: number; attributes: number; predicate: string | null }>(`SELECT c.relname AS name,
      t.relname AS table,am.amname AS method,i.indisunique AS unique,i.indnkeyatts AS keys,i.indnatts AS attributes,
      i.indoption::text AS options,pg_get_expr(i.indexprs,i.indrelid) AS expression,pg_get_expr(i.indpred,i.indrelid) AS predicate,
      ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(number,position)
        LEFT JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.number ORDER BY k.position) AS fields
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid JOIN pg_am am ON am.oid=c.relam
    WHERE i.indexrelid IN ('audit_events_origin_channel'::regclass,'copilot_quarantine_audit_origin_channel'::regclass)`)).rows;
  for (const [name, table, fields, options] of [
    ["audit_events_origin_channel", "audit_events", ["tenant_id", "principal_id", null, "started_at", "event_id"], "0 0 0 3 0"],
    ["copilot_quarantine_audit_origin_channel", "copilot_quarantine_audit", ["tenant_id", "principal_id", null, "observed_at"], "0 0 0 3"],
  ] as const) {
    const index = indexes.find(candidate => candidate.name === name);
    if (!index || index.table !== table || index.method !== "btree" || index.unique || index.predicate !== null
      || index.keys !== fields.length || index.attributes !== fields.length || index.options !== options
      || index.expression !== "(origin ->> 'channel'::text)" || JSON.stringify(index.fields) !== JSON.stringify(fields)) {
      throw new Error("audit_origin_schema_invalid");
    }
  }
  const { currentSchemaSql } = await import("./currentSchema.js");
  for (const name of ["audit_origin_valid", "protect_action_origin", "protect_audit_event_origin", "protect_inventory_mutation_stage"]) {
    const expected = currentSchemaSql.match(new RegExp(`CREATE FUNCTION ${name}\\([\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`))![1];
    const actual = (await database.query<{ prosrc: string; prosecdef: boolean; proconfig: string[]; provolatile: string; proparallel: string }>(
      "SELECT prosrc,prosecdef,proconfig,provolatile,proparallel FROM pg_proc WHERE oid=to_regprocedure($1)",
      [`public.${name}(${name === "audit_origin_valid" ? "jsonb" : ""})`])).rows[0];
    if (!actual || actual.prosrc !== expected || actual.prosecdef
      || JSON.stringify(actual.proconfig) !== JSON.stringify(["search_path=pg_catalog, public"])
      || actual.provolatile !== (name === "audit_origin_valid" ? "i" : "v")
      || actual.proparallel !== (name === "audit_origin_valid" ? "s" : "u")) throw new Error("audit_origin_schema_invalid");
  }
}
