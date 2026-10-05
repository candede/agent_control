import { userSourceFactsSql } from "./userSources.js";

export const officialAgentsSql = `
    SELECT agent_id AS identity,agent_id,
      COALESCE(max(agent_name) FILTER(WHERE kind='agents'),min(agent_name)) AS name,
      COALESCE(max(creator_type) FILTER(WHERE kind='agents'),min(creator_type)) AS creator_type,
      COALESCE(max(responses) FILTER(WHERE kind='agents'),sum(responses) FILTER(WHERE kind='userAgents')) AS responses,
      max(licensed_users) FILTER(WHERE kind='agents') AS licensed_users,
      max(unlicensed_users) FILTER(WHERE kind='agents') AS unlicensed_users,
      CASE WHEN count(*) FILTER(WHERE kind='userAgents')>0 THEN count(DISTINCT username) FILTER(WHERE kind='userAgents' AND responses>0) END AS active_users,
      CASE WHEN bool_or(kind='agents') THEN max(last_activity) FILTER(WHERE kind='agents') ELSE max(last_activity) END AS last_activity,
      max(responses) FILTER(WHERE kind='agents') AS report_responses,
      sum(responses) FILTER(WHERE kind='userAgents') AS bridge_responses,
      count(*) FILTER(WHERE kind='userAgents') AS relationship_count,
      bool_or(kind='agents' AND agent_name IS NOT NULL) AS has_primary_name,
      CASE WHEN bool_or(kind='agents') THEN 'agents' ELSE 'userAgents' END AS response_source
    FROM reports WHERE kind IN ('agents','userAgents') GROUP BY agent_id
`;

// Parameters 1..3 are the frozen user-source parameters; 4 is the tenant and
// 5 the captured complete set. Identity joins deliberately preserve ambiguity.
// FULL joins with a non-strict directory-presence filter keep PostgreSQL from
// choosing quadratic nested loops on unanalysed freshly published CTEs.
const reportColumns = `f.kind,f.payload_hash,f.identity_key,f.agent_id,f.username,f.agent_name,f.display_name,f.creator_type,
      f.responses,f.agents_used,f.licensed_users,f.unlicensed_users,f.last_activity`;
const reportRows = `SELECT ${reportColumns}
    FROM official_usage_set_versions m
    JOIN official_usage_version_rows r ON r.version_id=m.version_id AND r.tenant_id=m.tenant_id AND r.kind=m.kind
    JOIN official_usage_row_facts f ON f.tenant_id=r.tenant_id AND f.kind=r.kind AND f.payload_hash=r.payload_hash
    WHERE m.tenant_id=$4 AND m.set_id=$5`;
const reportKeyCounts = `SELECT identity_key,count(*) AS match_count,min(identity) AS identity FROM directory_keys GROUP BY identity_key`;
const unresolvedReports = `EXISTS(SELECT 1 FROM matches WHERE match_count<>1 OR user_rows>1 OR alias_ambiguous)
      OR EXISTS(SELECT 1 FROM resolved WHERE identity_count>1)`;

function relations(directory: string, reports: string, keyCounts = reportKeyCounts, unresolved: string | null = unresolvedReports, prefix = "") {
  return `WITH ${prefix} directory AS MATERIALIZED (${directory}),
  reports AS MATERIALIZED (${reports}), report_users AS (
    SELECT identity_key,username,
      max(display_name) FILTER(WHERE kind='users') AS display_name,
      max(responses) FILTER(WHERE kind='users') AS responses,
      max(agents_used) FILTER(WHERE kind='users') AS agents_used,
      sum(responses) FILTER(WHERE kind='userAgents') AS bridge_responses,
      count(*) FILTER(WHERE kind='userAgents') AS relationship_count,
      count(*) FILTER(WHERE kind='userAgents' AND responses>0) AS active_agent_count,
      bool_or(responses>0) AS has_activity,
      max(last_activity) FILTER(WHERE kind='users') AS user_last_activity,
      max(last_activity) AS last_activity,
      count(*) FILTER(WHERE kind='users') AS user_rows
    FROM reports WHERE kind IN ('users','userAgents') GROUP BY identity_key,username
  ), directory_keys AS MATERIALIZED (
    SELECT identity,identity AS identity_key FROM directory UNION SELECT identity,upn_key FROM directory
  ), directory_key_counts AS MATERIALIZED (
    ${keyCounts}
  ), ambiguous_directory_identities AS MATERIALIZED (
    SELECT DISTINCT d.identity FROM directory_keys d JOIN directory_key_counts k ON k.identity_key=d.identity_key
    WHERE k.match_count>1 AND EXISTS(SELECT 1 FROM report_users r WHERE r.identity_key=d.identity_key)
  ), matches AS (
    SELECT r.*,d.identity,COALESCE(d.match_count,0) AS match_count,
      EXISTS(SELECT 1 FROM ambiguous_directory_identities a WHERE a.identity=d.identity) AS alias_ambiguous
    FROM report_users r FULL JOIN directory_key_counts d ON r.identity_key=d.identity_key WHERE COALESCE(r.username,'')<>''
  ), resolved AS (
    SELECT *,count(*) OVER(PARTITION BY identity) AS identity_count FROM matches WHERE match_count=1 AND user_rows<=1 AND NOT alias_ambiguous
  ), ${unresolved === null ? "" : `combined AS MATERIALIZED (
  SELECT d.*,r.username AS reported_username,r.responses,r.agents_used,r.user_last_activity,r.last_activity,
    r.bridge_responses,r.relationship_count,r.active_agent_count,r.has_activity,r.user_rows,
    CASE WHEN r.identity IS NULL THEN 'missing' ELSE 'matched' END AS report_match,
    ${unresolved} AS unresolved
  FROM directory d FULL JOIN (SELECT * FROM resolved WHERE identity_count=1) r ON r.identity=d.identity
  WHERE COALESCE(d.identity,'')<>''
  ),`} matched_users AS (
    SELECT r.*,matched.identity AS matched_identity FROM report_users r
      FULL JOIN (SELECT * FROM resolved WHERE identity_count=1) matched ON matched.username=r.username
      WHERE COALESCE(r.username,'')<>''
  ), official_users AS (
    SELECT r.*,r.username AS identity,COALESCE(NULLIF(r.display_name,''),r.username) AS name,
      d.identity AS object_id,d.company,d.department,d.entitlement,d.service_state,
      CASE WHEN r.user_rows=0 THEN 'unknown' WHEN r.responses=0 THEN 'zero'
        WHEN r.responses<=$6::bigint THEN 'low' ELSE 'outside' END AS review_cohort
    FROM matched_users r FULL JOIN directory d ON d.identity=r.matched_identity WHERE COALESCE(r.username,'')<>''
  ), official_agents AS (${officialAgentsSql})`;
}

export const reportRelationsSql = relations(userSourceFactsSql(), reportRows);

// Only an already bounded directory candidate page enters this relation.
// Ambiguity still counts the complete captured directory, and unresolved
// evidence is the exact immutable whole-selection aggregate, not a page count.
export function selectedDirectoryReportRelationsSql(candidate: string, unresolvedParameter: string | null, prefix = "", extraKeys = "") {
  const reports = `SELECT ${reportColumns} FROM (
      SELECT identity AS identity_key FROM selected_directory
      UNION SELECT upn_key FROM selected_directory WHERE upn_key IS NOT NULL
      ${extraKeys}
    ) keys CROSS JOIN LATERAL (
      SELECT m.version_id,m.kind FROM official_usage_set_versions m
      WHERE m.tenant_id=$4 AND m.set_id=$5 AND m.kind IN ('users','userAgents')
    ) versions CROSS JOIN LATERAL (
      SELECT f.* FROM official_usage_row_facts f WHERE f.tenant_id=$4 AND f.kind=versions.kind
        AND f.identity_key=keys.identity_key
        AND EXISTS(SELECT 1 FROM official_usage_version_rows r WHERE r.version_id=versions.version_id
          AND r.tenant_id=$4 AND r.kind=f.kind AND r.payload_hash=f.payload_hash OFFSET 0)
      OFFSET 0
    ) f`;
  const keys = `SELECT k.identity_key,counted.match_count,k.identity FROM (
      SELECT identity_key,min(identity) AS identity FROM directory_keys GROUP BY identity_key
    ) k CROSS JOIN LATERAL (
      SELECT count(*) AS match_count FROM directory_user_rows d WHERE d.generation_id=$1
        AND (d.identity=k.identity_key OR d.upn_key=k.identity_key)
    ) counted`;
  return relations(userSourceFactsSql(true), reports, keys, unresolvedParameter === null ? null : `${unresolvedParameter}::boolean`,
    `${prefix}selected_directory AS MATERIALIZED (${candidate}),`);
}

export function selectedOfficialReportRelationsSql(kind: "users" | "agents" | "userAgents", candidate: string) {
  const prefix = `selected_report_keys AS MATERIALIZED (${candidate}),`;
  if (kind === "users") {
    const directory = `SELECT DISTINCT d.* FROM selected_report_keys k CROSS JOIN LATERAL (
      SELECT d.generation_id,d.identity,d.upn,d.upn_key,d.display_name,d.sort_key,d.company,d.department,
        d.account_enabled,d.user_type,d.employee_type,d.service_state,d.plan_count FROM directory_user_rows d
      WHERE d.generation_id=$1 AND (d.identity=k.identity_key OR d.upn_key=k.identity_key) OFFSET 0
    ) d`;
    return selectedDirectoryReportRelationsSql(directory, null, prefix,
      "UNION SELECT identity_key FROM selected_report_keys");
  }
  const reports = kind === "userAgents"
    ? `SELECT ${reportColumns} FROM selected_report_keys k JOIN official_usage_row_facts f
      ON f.tenant_id=$4 AND f.kind='userAgents' AND f.payload_hash=k.payload_hash`
    : `SELECT ${reportColumns} FROM selected_report_keys k CROSS JOIN LATERAL (
        SELECT m.version_id,m.kind FROM official_usage_set_versions m
        WHERE m.tenant_id=$4 AND m.set_id=$5 AND m.kind IN ('agents','userAgents')
      ) versions CROSS JOIN LATERAL (
        SELECT f.* FROM official_usage_row_facts f WHERE f.tenant_id=$4 AND f.kind=versions.kind AND f.agent_id=k.identity
          AND EXISTS(SELECT 1 FROM official_usage_version_rows r
            WHERE r.version_id=versions.version_id AND r.tenant_id=$4 AND r.kind=f.kind AND r.payload_hash=f.payload_hash OFFSET 0)
        OFFSET 0
      ) f`;
  return relations(userSourceFactsSql(), reports, reportKeyCounts, unresolvedReports, prefix);
}
