import { currentInventorySourcesSql } from "./inventoryAuthority.js";
import { selectedInventorySourcesSql } from "./inventorySelections.js";
import { selectedDirectoryReportRelationsSql } from "./officialReportQueries.js";
import { championOrderSql } from "../services/championRanking.js";
import { userSourceSearchSql } from "./userSources.js";

// Parallel hashes can exhaust bounded PostgreSQL shared memory before spilling.
export const discoveryQuerySettingsSql = "SET LOCAL enable_parallel_hash = off";
const liveSources = currentInventorySourcesSql.replace(/\$[1-4]\b/g, parameter =>
  ({ $1: "$4", $2: "$8", $3: "NULL", $4: "$3" })[parameter]!);
const parameters = `parameters AS (SELECT $1::uuid p1,$2::uuid p2,$3::timestamptz p3,$4::text p4,$5::uuid p5,
  $6::integer p6,$7::uuid p7,$8::text p8,$9::boolean p9,$10::text p10,$11::text p11,$12::jsonb p12)`;
const affiliation = (field: string, parameter: string) =>
  `${userSourceSearchSql(`nullif(btrim(${field}),'')`)}=${userSourceSearchSql(parameter)}`;
// 1 directory generation, 2 activity generation (always absent), 3 time,
// 4 tenant, 5 pinned report set, 6 report threshold, 7 selection, 8 actor,
// 9 privacy, 10 company, 11 department, 12 hidden champion identities.
function discoveryClassificationCtes(agentIdsParameter?: string) {
  return `live AS MATERIALIZED (
  ${agentIdsParameter ? `SELECT l.* FROM (${liveSources}) l WHERE l.agent_id=ANY(${agentIdsParameter}::text[])` : liveSources}
), selected_sources AS (
  ${selectedInventorySourcesSql("$4", "$8", "NULL", "$7")}
), sources AS MATERIALIZED (
  SELECT DISTINCT l.agent_id,l.control_revision,l.native_id,l.normalized_native_id,l.normalized_environment_id,
    s.generation_id,s.identity,s.display_name,s.domain,s.observed_at,s.resource_type,s.publisher,s.residual,
    s.residual->>'longDescription' AS long_description,s.residual->>'shortDescription' AS short_description,
    s.residual->'details'->>'description' AS native_description,
    s.residual->>'lifecycle' AS lifecycle,lower(s.residual->>'createdBy') AS creator,
    lower(s.residual->>'ownerId') AS owner_id,lower(s.residual->'details'->>'ownerId') AS details_owner_id,
    lower(s.residual->'details'->>'createdBy') AS details_creator
  FROM live l JOIN selected_sources pin ON pin.agent_id=l.agent_id AND pin.source_generation_id=l.source_generation_id
    AND pin.source_identity=l.source_identity AND pin.control_revision=l.control_revision
  JOIN inventory_records s ON s.generation_id=l.source_generation_id AND s.identity=l.source_identity
), origin_evidence AS MATERIALIZED (
  SELECT s.agent_id,claim.kind,jsonb_build_object('source',CASE WHEN s.domain='packages' THEN 'graph_packages' ELSE 'power_platform' END,
    'generationId',s.generation_id,'sourceIdentity',s.identity,'revision',s.control_revision,
    'field',claim.field,'setId',claim.set_id,'versionId',claim.version_id) AS evidence
  FROM sources s CROSS JOIN LATERAL (
    SELECT CASE WHEN s.domain='power_platform' AND s.resource_type='microsoft.copilotstudio/agents' THEN 'organization_created'
      WHEN s.domain='packages' AND lower(btrim(s.residual->>'type')) IN ('lob','custom') THEN 'organization_created'
      WHEN s.domain='packages' AND lower(btrim(s.residual->>'type')) IN ('firstparty','microsoft')
        THEN CASE WHEN nullif(btrim(s.publisher),'') IS NULL OR lower(btrim(s.publisher))='microsoft' THEN 'microsoft' ELSE 'unknown' END
      WHEN s.domain='packages' AND lower(btrim(s.residual->>'type')) IN ('thirdparty','external') THEN 'third_party'
      ELSE NULL END AS kind,CASE WHEN s.domain='packages' THEN 'type' ELSE 'resourceType' END AS field,
      NULL::uuid AS set_id,NULL::uuid AS version_id
    UNION ALL SELECT 'microsoft','publisher',NULL::uuid,NULL::uuid
      WHERE s.domain='packages' AND lower(btrim(s.publisher))='microsoft'
    UNION ALL SELECT CASE lower(btrim(f.creator_type)) WHEN 'your org' THEN 'organization_created'
      WHEN 'microsoft' THEN 'microsoft' WHEN 'third party' THEN 'third_party' WHEN '3rd party' THEN 'third_party'
      ELSE 'unknown' END,'creatorType',m.set_id,m.version_id
    FROM official_usage_set_versions m
    JOIN official_usage_sets report ON report.id=m.set_id AND report.tenant_id=m.tenant_id
      AND report.complete AND report.deleted_at IS NULL
      AND (report.expires_at IS NULL OR report.expires_at>GREATEST($3,clock_timestamp()))
    JOIN official_usage_version_rows r ON r.version_id=m.version_id AND r.tenant_id=m.tenant_id AND r.kind=m.kind
    JOIN official_usage_row_facts f ON f.tenant_id=r.tenant_id AND f.kind=r.kind AND f.payload_hash=r.payload_hash
    WHERE s.domain='packages' AND m.tenant_id=$4 AND m.set_id=$5 AND m.kind IN ('agents','userAgents')
      AND f.agent_id=s.native_id AND nullif(btrim(f.creator_type),'') IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM agent_usage_associations a WHERE a.tenant_id=$4 AND a.report_set_id=$5
        AND a.report_agent_id=f.agent_id AND (a.source<>'graph_packages' OR a.normalized_native_id<>s.native_id))
  ) claim WHERE claim.kind IS NOT NULL
), classified AS MATERIALIZED (
  SELECT agent_id,CASE WHEN count(DISTINCT kind)=1 THEN min(kind) ELSE 'unknown' END AS origin,
    jsonb_agg(DISTINCT evidence) AS origin_evidence FROM origin_evidence GROUP BY agent_id
), eligible AS MATERIALIZED (
  SELECT * FROM classified WHERE origin IN ('organization_created','microsoft')
)`;
}
export function discoveryCatalogQuery(agentIdsParameter?: string, createdHere = false, search = false) {
  return `WITH ${parameters},${discoveryClassificationCtes(agentIdsParameter)}, descriptive_sources AS MATERIALIZED (
  SELECT s.*,e.origin,e.origin_evidence FROM sources s JOIN eligible e USING(agent_id)
    ${createdHere ? `WHERE e.origin='organization_created' AND EXISTS(
      SELECT 1 FROM sources maker JOIN directory_user_rows creator ON creator.generation_id=$1
        AND creator.identity=lower(maker.residual->>'createdBy')
      WHERE maker.agent_id=s.agent_id AND ${affiliation("creator.company", "$10")} AND ${affiliation("creator.department", "$11")})` : ""}
), descriptions AS MATERIALIZED (
  SELECT s.*,
    CASE WHEN domain<>'packages' THEN 'details.description'
      WHEN coalesce(nullif(btrim(long_description),''),nullif(btrim(chunks.long_text),'')) IS NOT NULL THEN 'longDescription'
      WHEN coalesce(nullif(btrim(short_description),''),nullif(btrim(chunks.short_text),'')) IS NOT NULL THEN 'shortDescription'
      ELSE 'longDescription' END AS description_field,
    CASE WHEN domain='packages' THEN coalesce(nullif(btrim(long_description),''),nullif(btrim(chunks.long_text),''),
      nullif(btrim(short_description),''),nullif(btrim(chunks.short_text),''))
      ELSE coalesce(nullif(btrim(native_description),''),nullif(btrim(chunks.native_text),'')) END AS description
  FROM descriptive_sources s LEFT JOIN LATERAL (
    SELECT string_agg(f.payload->>'text','' ORDER BY f.value::integer) FILTER(WHERE kind='about:long') AS long_text,
      string_agg(f.payload->>'text','' ORDER BY f.value::integer) FILTER(WHERE kind='about:short') AS short_text,
      string_agg(f.payload->>'text','' ORDER BY f.value::integer) FILTER(WHERE kind='about:native') AS native_text
    FROM inventory_facts f WHERE f.generation_id=s.generation_id AND f.identity=s.identity AND f.kind IN ('about:long','about:short','about:native')
      AND (s.domain='packages' AND nullif(btrim(s.long_description),'') IS NULL
        OR s.domain='power_platform' AND nullif(btrim(s.native_description),'') IS NULL)
  ) chunks ON true
)${search ? `, candidates AS MATERIALIZED (
  SELECT agent_id FROM descriptions WHERE ($13::jsonb='[]'::jsonb OR EXISTS(
    SELECT 1 FROM jsonb_array_elements_text($13::jsonb) term WHERE
      strpos(${userSourceSearchSql("coalesce(description,'')")},term)>0
      OR strpos(${userSourceSearchSql("coalesce(display_name,'')")},term)>0))
    AND ($13::jsonb<>'[]'::jsonb OR $14::integer IS NULL OR agent_id>$15)
  GROUP BY agent_id ORDER BY agent_id COLLATE "C" LIMIT CASE WHEN $13::jsonb='[]'::jsonb THEN $16::integer ELSE NULL END
)` : ""}, described_people AS (
  SELECT s.*,ARRAY(SELECT DISTINCT value FROM unnest(ARRAY[s.owner_id,s.creator,s.details_owner_id,s.details_creator]) value
    WHERE value IS NOT NULL AND value<>'') AS people
  FROM descriptions s ${search ? "JOIN candidates candidate ON candidate.agent_id=s.agent_id" : ""}
), described AS (
  SELECT s.*,coalesce(p.value,'[]'::jsonb) AS people_evidence,
    cardinality(s.people)>0 AND cardinality(s.people)=coalesce(p.matched,0) AND coalesce(p.identifiable,false) AS evidence_complete
  FROM described_people s
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS matched,bool_and(nullif(btrim(d.display_name),'') IS NOT NULL AND nullif(btrim(d.upn),'') IS NOT NULL) AS identifiable,
      jsonb_agg(jsonb_build_object('id',d.identity,'name',d.display_name,
      'contact',d.upn,'company',nullif(btrim(d.company),''),'department',nullif(btrim(d.department),''),
      'created',d.identity=s.creator)) AS value
    FROM directory_user_rows d WHERE d.generation_id=$1 AND d.identity=ANY(s.people)
  ) p ON true
), validated_sources AS MATERIALIZED (
  SELECT s.*,discovery_safe_text(description,'[]'::jsonb,false,true) AS inert_description FROM described s
), rendered_sources AS (
  SELECT agent_id,domain,generation_id,identity,control_revision,origin,origin_evidence,description_field,observed_at,lifecycle,people_evidence,evidence_complete,
    coalesce((SELECT jsonb_agg(jsonb_build_object(
      'company',CASE WHEN $9 THEN discovery_safe_text(p->>'company',people_evidence||$12::jsonb,true,evidence_complete) ELSE p->>'company' END,
      'department',CASE WHEN $9 THEN discovery_safe_text(p->>'department',people_evidence||$12::jsonb,true,evidence_complete) ELSE p->>'department' END))
      FROM jsonb_array_elements(people_evidence) p WHERE p->>'company' IS NOT NULL OR p->>'department' IS NOT NULL),'[]'::jsonb) AS affiliations,
    discovery_safe_text(display_name,people_evidence||$12::jsonb,$9::boolean,evidence_complete) AS title,
    discovery_safe_text(inert_description,people_evidence||$12::jsonb,$9::boolean,evidence_complete) AS source_description,
    CASE WHEN description IS NULL THEN 'absent' WHEN octet_length(description)>4194304 THEN 'limit_withheld'
      WHEN octet_length(inert_description)>4194304 THEN 'limit_withheld'
      WHEN inert_description IS NULL THEN 'unsafe_withheld'
      WHEN $9 AND NOT evidence_complete THEN 'privacy_withheld' ELSE 'available' END AS source_description_state,
    display_name IS NOT NULL AS had_title,description IS NOT NULL AS had_description
  FROM validated_sources
), safe_sources AS MATERIALIZED (
  SELECT *,CASE WHEN bool_or(had_description AND source_description IS NULL) OVER(PARTITION BY agent_id)
    OR sum(octet_length(source_description)) OVER(PARTITION BY agent_id)>16777216
    THEN NULL ELSE source_description END AS description,
    sum(octet_length(source_description)) OVER(PARTITION BY agent_id) AS description_bytes FROM rendered_sources
), catalog AS MATERIALIZED (
  SELECT agent_id AS identity,min(origin) AS origin,(jsonb_agg(origin_evidence)->0) AS origin_evidence,
    (array_agg(title ORDER BY domain,observed_at DESC,title COLLATE "C") FILTER(WHERE title IS NOT NULL))[1] AS title,
    string_agg(DISTINCT description,E'\\n\\n' ORDER BY description) FILTER(WHERE description_bytes<=16777216) AS description,
    bool_or(had_title) AS had_title,bool_or(had_description) AS had_description,
    CASE WHEN bool_or(source_description_state='unsafe_withheld') THEN 'unsafe_withheld'
      WHEN bool_or(source_description_state='privacy_withheld') THEN 'privacy_withheld'
      WHEN bool_or(source_description_state='limit_withheld') OR max(description_bytes)>16777216 THEN 'limit_withheld'
      WHEN bool_or(had_description) THEN 'available' ELSE 'absent' END AS description_state,
    CASE WHEN bool_or(lifecycle='published') THEN 'published' WHEN bool_or(lifecycle='draft') THEN 'draft' ELSE 'unknown' END AS lifecycle,
    jsonb_path_query_array(jsonb_agg(people_evidence),'$[*][*]') AS people,
    jsonb_path_query_array(jsonb_agg(affiliations),'$[*][*]') AS affiliations,
    bool_and(evidence_complete) AS evidence_complete,
    jsonb_agg(DISTINCT jsonb_build_object('source',CASE WHEN domain='packages' THEN 'graph_packages' ELSE 'power_platform' END,
      'generationId',generation_id,'sourceIdentity',identity,'revision',control_revision,
      'observedAt',observed_at,'descriptionField',description_field,
      'descriptionState',source_description_state)) AS sources
  FROM safe_sources s GROUP BY agent_id
)`;
}
export const discoverySearchSql = `${discoveryCatalogQuery(undefined, false, true)}, scored AS (
  SELECT *, (SELECT count(*)::int FROM jsonb_array_elements_text($13::jsonb) term
    WHERE strpos(${userSourceSearchSql("coalesce(description,'')")},term)>0)*2
    +(SELECT count(*)::int FROM jsonb_array_elements_text($13::jsonb) term
    WHERE strpos(${userSourceSearchSql("coalesce(title,'')")},term)>0) AS rank FROM catalog
), page AS MATERIALIZED (SELECT * FROM scored WHERE ($13::jsonb='[]'::jsonb OR rank>0)
  AND ($14::integer IS NULL OR rank<$14 OR rank=$14 AND identity>$15)
  ORDER BY rank DESC,identity COLLATE "C" LIMIT $16
), excerpts AS (
  SELECT s.agent_id,jsonb_agg(DISTINCT jsonb_build_object(
    'source',CASE WHEN s.domain='packages' THEN 'graph_packages' ELSE 'power_platform' END,
    'generationId',s.generation_id,'sourceIdentity',s.identity,'revision',s.control_revision,
    'field',field.name,'excerpt',substring(field.value FROM greatest(m.position-80,1) FOR 320))) AS value
  FROM safe_sources s JOIN page p ON p.identity=s.agent_id
  CROSS JOIN LATERAL (VALUES ('description',s.description),('title',s.title)) field(name,value)
  CROSS JOIN LATERAL (SELECT min(nullif(strpos(${userSourceSearchSql("field.value")},term),0)) AS position
    FROM jsonb_array_elements_text($13::jsonb) term) m
  WHERE m.position IS NOT NULL GROUP BY s.agent_id
) SELECT p.*,coalesce(e.value,'[]'::jsonb) AS evidence FROM page p LEFT JOIN excerpts e ON e.agent_id=p.identity
  ORDER BY p.rank DESC,p.identity COLLATE "C"`;

export const discoveryEligibilityQuery = `WITH ${parameters},${discoveryClassificationCtes()} SELECT agent_id FROM eligible`;

export const discoveryWorkplaceSql = `${selectedDirectoryReportRelationsSql(
  `SELECT * FROM directory_user_rows WHERE generation_id=$1 AND ${affiliation("company", "$10")}`,
  "false", `${parameters},`)}, scoped_users AS MATERIALIZED (
  SELECT * FROM combined WHERE ${affiliation("company", "$10")}
), user_agents AS MATERIALIZED (
  SELECT DISTINCT r.agent_id,u.identity AS user_id
  FROM reports r JOIN resolved matched ON matched.username=r.username AND matched.identity_count=1
  JOIN scoped_users u ON u.identity=matched.identity WHERE r.kind='userAgents' AND r.responses>0
), person_agent_counts AS (
  SELECT user_id,count(*) AS agents FROM user_agents GROUP BY user_id
), person_metrics AS (
  SELECT u.identity,coalesce(nullif(u.display_name,''),u.upn) AS name,u.upn AS contact,u.company,u.department,
    coalesce(u.responses,u.bridge_responses) AS responses,
    coalesce(a.agents,0) AS agents,u.report_match
  FROM scoped_users u LEFT JOIN person_agent_counts a ON a.user_id=u.identity WHERE ${affiliation("u.department", "$11")}
), ranked_people AS (
  SELECT *,row_number() OVER(ORDER BY ${championOrderSql()}) AS rank FROM person_metrics
), champions AS (
  SELECT identity,name,contact,company,department,rank FROM ranked_people WHERE rank<=3 AND (coalesce(responses,0)>0 OR agents>0)
)`;

const discoveryAgentLinksSql = `, relevant_agents AS MATERIALIZED (
  SELECT DISTINCT agent_id FROM user_agents
), current_sources AS NOT MATERIALIZED (
  ${liveSources}
), links AS (
  SELECT DISTINCT s.agent_id AS canonical_id,a.report_agent_id FROM current_sources s JOIN agent_usage_associations a
    ON a.tenant_id=$4 AND a.report_set_id=$5 AND a.source=s.source AND a.normalized_native_id=s.normalized_native_id
      AND a.normalized_environment_id=s.normalized_environment_id
  JOIN relevant_agents needed ON needed.agent_id=a.report_agent_id
  UNION SELECT s.agent_id,s.native_id FROM current_sources s JOIN relevant_agents needed ON needed.agent_id=s.native_id
    WHERE s.source='graph_packages'
    AND NOT EXISTS(SELECT 1 FROM agent_usage_associations a WHERE a.tenant_id=$4 AND a.report_set_id=$5 AND a.report_agent_id=s.native_id)
), unique_links AS (
  SELECT report_agent_id,min(canonical_id) AS canonical_id FROM links GROUP BY report_agent_id HAVING count(DISTINCT canonical_id)=1
), popularity AS (
  SELECT link.canonical_id AS identity,count(DISTINCT a.user_id) AS company_users,
    count(DISTINCT a.user_id) FILTER(WHERE ${affiliation("u.department", "$11")}) AS department_users
  FROM user_agents a JOIN scoped_users u ON u.identity=a.user_id JOIN unique_links link ON link.report_agent_id=a.agent_id
  GROUP BY link.canonical_id
)`;
export const discoveryPopularitySql = `${discoveryWorkplaceSql}${discoveryAgentLinksSql},${discoveryClassificationCtes()},
  ranked AS (SELECT p.*,row_number() OVER(ORDER BY company_users DESC,identity COLLATE "C") AS company_rank,
    row_number() OVER(ORDER BY department_users DESC,identity COLLATE "C") AS department_rank
    FROM popularity p JOIN eligible e ON e.agent_id=p.identity)
  SELECT identity,company_users,department_users FROM ranked WHERE company_rank<=$13 OR department_rank<=$13`;
