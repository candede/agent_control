import type pg from "pg";

export const agentDiscoverySchemaSql = String.raw`
CREATE FUNCTION discovery_safe_text(value text, evidence jsonb, hide_identity boolean, evidence_complete boolean)
RETURNS text LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE identity_pattern text; result text := value;
BEGIN
  IF value IS NULL THEN RETURN NULL; END IF;
  IF octet_length(value)>4194304 THEN RETURN NULL; END IF;
  result := normalize(value,NFKC);
  IF result ~* '(ignore (all |previous |prior )?instructions|system prompt|<script|javascript:|data:text/)' THEN
    RETURN NULL;
  END IF;
  IF NOT hide_identity THEN RETURN result; END IF;
  IF NOT evidence_complete THEN RETURN NULL; END IF;
  SELECT string_agg(regexp_replace(token,'([\\.^$|?*+(){}\[\]])','\\\1','g'),'|' ORDER BY length(token) DESC,token COLLATE "C")
    INTO identity_pattern
    FROM (SELECT DISTINCT normalize(item,NFKC) AS token FROM jsonb_array_elements(evidence) person
      CROSS JOIN LATERAL unnest(ARRAY[person->>'id',person->>'name',person->>'contact']) item
      WHERE item IS NOT NULL AND item<>'') tokens;
  IF identity_pattern IS NOT NULL THEN
    result := regexp_replace(result,identity_pattern,'[identity withheld]','gi');
  END IF;
  result := regexp_replace(result,'https?://[^[:space:]<>"]+','[link withheld]','gi');
  result := regexp_replace(result,'[[:alnum:]._%+-]+@[[:alnum:].-]+','[identity withheld]','gi');
  result := regexp_replace(result,'[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}','[identity withheld]','gi');
  RETURN result;
END $$;
`;

export async function verifyAgentDiscoverySchema(database: Pick<pg.Pool, "query">) {
  const row = (await database.query<{ valid: boolean }>(`SELECT
    to_regprocedure('discovery_safe_text(text,jsonb,boolean,boolean)') IS NOT NULL
    AS valid`)).rows[0];
  if (!row?.valid) throw new Error("discovery_schema_invalid");
}
