import type pg from "pg";

export const adoptionContentSchemaSql = String.raw`
CREATE TABLE adoption_content(
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL CHECK(length(tenant_id) BETWEEN 1 AND 128),
  creator_id text NOT NULL CHECK(length(creator_id) BETWEEN 1 AND 256),
  kind text NOT NULL CHECK(kind IN ('brief','card','action')),
  revision integer NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 2147483646),
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=32768),
  baseline jsonb CHECK(baseline IS NULL OR (jsonb_typeof(baseline)='object' AND octet_length(baseline::text)<=16384)),
  agent_references jsonb NOT NULL CHECK(jsonb_typeof(agent_references)='array' AND jsonb_array_length(agent_references)<=8
    AND octet_length(agent_references::text)<=16384),
  linked_references jsonb NOT NULL CHECK(jsonb_typeof(linked_references)='array' AND jsonb_array_length(linked_references)<=8
    AND octet_length(linked_references::text)<=2048),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX adoption_content_tenant_list ON adoption_content(tenant_id,id);
CREATE INDEX adoption_content_creator ON adoption_content(tenant_id,creator_id,id);
CREATE TABLE adoption_content_receipts(
  tenant_id text NOT NULL CHECK(length(tenant_id) BETWEEN 1 AND 128),
  actor_id text NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 256),
  request_id text NOT NULL CHECK(length(request_id)<=80),
  payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
  content_id uuid NOT NULL,
  deleted boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(tenant_id,actor_id,request_id),
  UNIQUE(content_id)
);
CREATE INDEX adoption_content_receipts_expiry ON adoption_content_receipts(expires_at);
CREATE VIEW adoption_content_storage AS SELECT tenant_id,count(*)::bigint AS records,
  sum(octet_length(row_to_json(c)::text))::bigint AS bytes FROM (
    SELECT tenant_id,to_jsonb(r) AS data FROM adoption_content r
    UNION ALL SELECT tenant_id,to_jsonb(r) FROM adoption_content_receipts r
  ) c GROUP BY tenant_id;
`;

export async function verifyAdoptionContentSchema(database: Pick<pg.Pool, "query">) {
  const row = (await database.query<{ valid: boolean }>(`SELECT
    to_regclass('adoption_content') IS NOT NULL AND to_regclass('adoption_content_receipts') IS NOT NULL
    AND to_regclass('adoption_content_storage') IS NOT NULL
    AND (SELECT array_agg(column_name::text ORDER BY ordinal_position) FROM information_schema.columns
      WHERE table_schema='public' AND table_name='adoption_content')=
      ARRAY['id','tenant_id','creator_id','kind','revision','payload','baseline','agent_references','linked_references','created_at','updated_at']
    AND (SELECT array_agg(column_name::text ORDER BY ordinal_position) FROM information_schema.columns
      WHERE table_schema='public' AND table_name='adoption_content_receipts')=
      ARRAY['tenant_id','actor_id','request_id','payload_hash','content_id','deleted','expires_at']
    AND (SELECT count(*) FROM pg_constraint WHERE conrelid='adoption_content'::regclass)=9
    AND (SELECT count(*) FROM pg_constraint WHERE conrelid='adoption_content_receipts'::regclass)=6 AND
    (current_user<>'agentcontrol_app' OR (
      (SELECT bool_and(has_table_privilege(current_user,relation,privilege))
        FROM (VALUES ('adoption_content'),('adoption_content_receipts')) objects(relation)
        CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE')) grants(privilege))
      AND NOT has_table_privilege(current_user,'adoption_content','TRUNCATE')
      AND NOT has_table_privilege(current_user,'adoption_content_receipts','TRUNCATE')
      AND has_table_privilege(current_user,'adoption_content_storage','SELECT'))) AS valid`)).rows[0];
  if (!row?.valid) throw new Error("adoption_content_schema_invalid");
}
