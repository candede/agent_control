import type pg from "pg";

// Receipts correlate existing jobs; they do not own execution state.
export const agentControlReceiptsSql = String.raw`
CREATE TABLE agent_control_receipts (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  principal_id text NOT NULL,
  authorization_hash text NOT NULL CHECK (authorization_hash ~ '^[a-f0-9]{64}$'),
  session_epoch bigint NOT NULL CHECK (session_epoch>=0),
  selection_id uuid NOT NULL,
  confirmation_hash text NOT NULL CHECK (confirmation_hash ~ '^[a-f0-9]{64}$'),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=524288),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  retained_until timestamptz NOT NULL DEFAULT clock_timestamp()+interval '30 days',
  idempotency_key text CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  initiating_actor jsonb,
  origin jsonb,
  accepted_at timestamptz,
  CHECK (expires_at>created_at AND retained_until>expires_at),
  CHECK ((accepted_at IS NULL AND idempotency_key IS NULL AND initiating_actor IS NULL AND origin IS NULL)
    OR (accepted_at IS NOT NULL AND idempotency_key IS NOT NULL AND initiating_actor IS NOT NULL AND origin IS NOT NULL
      AND audit_origin_valid(origin) AND jsonb_typeof(initiating_actor)='object'
      AND initiating_actor ?& ARRAY['tenantId','homeAccountId','username','displayName']
      AND initiating_actor-ARRAY['tenantId','homeAccountId','username','displayName']='{}'::jsonb
      AND initiating_actor->>'tenantId'=tenant_id AND initiating_actor->>'homeAccountId'=principal_id
      AND jsonb_typeof(initiating_actor->'username')='string' AND length(initiating_actor->>'username') BETWEEN 1 AND 256
      AND jsonb_typeof(initiating_actor->'displayName')='string' AND length(initiating_actor->>'displayName')<=256))
);
CREATE UNIQUE INDEX agent_control_receipts_idempotency ON agent_control_receipts(tenant_id,principal_id,idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX agent_control_receipts_retention ON agent_control_receipts(retained_until,id);
CREATE INDEX agent_control_receipts_admission ON agent_control_receipts(tenant_id,principal_id,expires_at)
  WHERE accepted_at IS NULL;
CREATE FUNCTION protect_agent_control_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path TO pg_catalog,public AS $$
BEGIN
  IF to_jsonb(NEW)-ARRAY['idempotency_key','initiating_actor','origin','accepted_at']
      IS DISTINCT FROM to_jsonb(OLD)-ARRAY['idempotency_key','initiating_actor','origin','accepted_at']
    OR OLD.accepted_at IS NOT NULL AND NEW IS DISTINCT FROM OLD
    OR NEW.accepted_at IS NULL THEN
    RAISE EXCEPTION 'agent control receipt is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_agent_control_receipt BEFORE UPDATE ON agent_control_receipts
  FOR EACH ROW EXECUTE FUNCTION protect_agent_control_receipt();
REVOKE ALL ON agent_control_receipts FROM PUBLIC,agentcontrol_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON agent_control_receipts TO agentcontrol_app;
REVOKE ALL ON FUNCTION protect_agent_control_receipt() FROM PUBLIC,agentcontrol_app;
`;

export async function verifyAgentControlReceiptsSchema(database: Pick<pg.Pool, "query">) {
  const result = (await database.query<{ valid: boolean }>(`SELECT
    (SELECT count(*)=15 AND md5(string_agg(attname||':'||format_type(atttypid,atttypmod)||':'||attnotnull||':'
      ||coalesce(pg_get_expr(adbin,adrelid),''),chr(10) ORDER BY attnum))='ac08a3a5c133f8ae37137329143d6172'
      FROM pg_attribute LEFT JOIN pg_attrdef ON adrelid=attrelid AND adnum=attnum
      WHERE attrelid=to_regclass('agent_control_receipts') AND attnum>0 AND NOT attisdropped)
    AND (SELECT array_agg(indexdef ORDER BY indexname)=$1::text[] FROM pg_indexes WHERE tablename='agent_control_receipts')
    AND (SELECT count(*)=8 AND bool_and(convalidated)
      AND md5(string_agg(conname||':'||pg_get_constraintdef(oid),chr(10) ORDER BY conname))='694dc72f67a193b52f011d352ae5f65b'
      FROM pg_constraint WHERE conrelid=to_regclass('agent_control_receipts'))
    AND EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('protect_agent_control_receipt()') AND prosrc=$2 AND NOT prosecdef)
    AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('agent_control_receipts')
      AND tgname='protect_agent_control_receipt' AND NOT tgisinternal AND tgenabled IN ('O','A')
      AND tgfoid=to_regprocedure('protect_agent_control_receipt()') AND tgtype=19 AND tgnargs=0 AND tgqual IS NULL)
    AND (current_user<>'agentcontrol_app' OR (
      has_table_privilege(current_user,'agent_control_receipts','SELECT,INSERT,UPDATE,DELETE')
      AND NOT has_table_privilege(current_user,'agent_control_receipts','TRUNCATE')
      AND NOT has_function_privilege(current_user,'protect_agent_control_receipt()','EXECUTE')))
    AS valid`, [[
      "CREATE INDEX agent_control_receipts_admission ON public.agent_control_receipts USING btree (tenant_id, principal_id, expires_at) WHERE (accepted_at IS NULL)",
      "CREATE UNIQUE INDEX agent_control_receipts_idempotency ON public.agent_control_receipts USING btree (tenant_id, principal_id, idempotency_key) WHERE (idempotency_key IS NOT NULL)",
      "CREATE UNIQUE INDEX agent_control_receipts_pkey ON public.agent_control_receipts USING btree (id)",
      "CREATE INDEX agent_control_receipts_retention ON public.agent_control_receipts USING btree (retained_until, id)",
    ], agentControlReceiptsSql.split("AS $$")[1].split("$$;")[0]])).rows[0];
  if (!result?.valid) throw new Error("agent_control_receipt_schema_invalid");
}
