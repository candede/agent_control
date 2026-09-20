import type pg from "pg";
import { pool, transaction } from "../db/pool.js";
import { AppError } from "../errors.js";
import type { OfficialUsageOverviewView } from "../types/officialUsage.js";
import { retainedSetIntegritySql, validateOfficialUsageHistoryOptions } from "./officialUsageHistory.js";

export type OfficialUsageOverviewOptions = {
  search?: string;
  startDate?: string;
  endDate?: string;
  sortBy?: "agentName" | "lastActivity";
  sortDirection?: "asc" | "desc";
  limit?: number;
  offset?: number;
};

type OverviewRow = {
  revision: string;
  retained_sets: number;
  reported_agents: number;
  used_agents: number;
  active_agents: number;
  undated_agents: number;
  earliest_activity: string | null;
  latest_activity: string | null;
  agent_count: number;
  agents: OfficialUsageOverviewView["agents"]["value"];
};

export class OfficialUsageOverviewService {
  constructor(private readonly database: pg.Pool = pool, private readonly now: () => Date = () => new Date()) {}

  async getOverview(tenantId: string, options: OfficialUsageOverviewOptions = {}): Promise<OfficialUsageOverviewView> {
    if (!tenantId) throw new AppError(403, "scope_mismatch", "Official usage overview requires an exact tenant scope.");
    const { limit, offset, ...filters } = validateOfficialUsageOverviewOptions(options);
    const now = this.now();
    const asOf = now.toISOString();
    const today = asOf.slice(0, 10);
    const activeSince = new Date(now);
    activeSince.setUTCDate(activeSince.getUTCDate() - 29);
    const activeSinceDateUtc = activeSince.toISOString().slice(0, 10);
    return transaction(this.database, async client => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await client.query<OverviewRow>(overviewSql(filters.sortBy, filters.sortDirection), [
        tenantId, filters.startDate, filters.endDate, filters.search, activeSinceDateUtc, today, limit, offset,
      ]);
      const row = result.rows[0]!;
      return {
        revision: Number(row.revision),
        summary: {
          retainedSets: row.retained_sets,
          reportedAgents: row.reported_agents,
          usedAgents: row.used_agents,
          activeAgents30Days: row.active_agents,
          undatedAgents: row.undated_agents,
          earliestActivityDateUtc: row.earliest_activity,
          latestActivityDateUtc: row.latest_activity,
          asOf,
          activeSinceDateUtc,
        },
        agents: { value: row.agents, count: row.agent_count, limit, offset },
        filters,
      };
    });
  }
}

export function validateOfficialUsageOverviewOptions(options: OfficialUsageOverviewOptions) {
  const paging = validateOfficialUsageHistoryOptions(options);
  if (options.search !== undefined && (typeof options.search !== "string" ||
      options.search.length > 256 || /[\r\n\0]/.test(options.search))) {
    throw new AppError(400, "invalid_usage_query", "The official usage search must be at most 256 characters of text.");
  }
  const startDate = strictDate(options.startDate);
  const endDate = strictDate(options.endDate);
  if (startDate && endDate && startDate > endDate) {
    throw new AppError(400, "invalid_usage_query", "The official usage start date must not be after the end date.");
  }
  const sortBy = options.sortBy ?? "lastActivity";
  const sortDirection = options.sortDirection ?? "desc";
  if (!["agentName", "lastActivity"].includes(sortBy) || !["asc", "desc"].includes(sortDirection)) {
    throw new AppError(400, "invalid_usage_query", "The official usage overview sort is not supported.");
  }
  return { ...paging, search: options.search?.trim() || null, startDate, endDate, sortBy, sortDirection };
}

function strictDate(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) ||
      new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw new AppError(400, "invalid_usage_query", "The official usage date filter must be a valid UTC YYYY-MM-DD date.");
  }
  return value;
}

function overviewSql(sortBy: "agentName" | "lastActivity", sortDirection: "asc" | "desc") {
  const order = `${sortBy === "agentName" ? "agent_name" : "last_activity"} ${sortDirection} NULLS LAST,agent_id COLLATE "C" ASC`;
  return `WITH retained_sets AS MATERIALIZED (
      SELECT report_set.id,report_set.tenant_id,report_set.accepted_at
      FROM official_usage_sets report_set
      WHERE report_set.tenant_id=$1 AND report_set.complete AND report_set.accepted_at IS NOT NULL
        AND report_set.deleted_at IS NULL AND ${retainedSetIntegritySql}
        -- A deleted accepted correction still supersedes the incorrect original.
        AND NOT EXISTS (
          SELECT 1 FROM official_usage_sets replacement
          WHERE replacement.tenant_id=report_set.tenant_id AND replacement.supersedes_set_id=report_set.id
            AND replacement.complete AND replacement.accepted_at IS NOT NULL
        )
    ), retained_versions AS MATERIALIZED (
      SELECT DISTINCT ON (version.id) version.id,version.tenant_id,version.kind,
        report_set.id AS set_id,report_set.accepted_at
      FROM retained_sets report_set
      JOIN official_usage_set_versions membership
        ON membership.set_id=report_set.id AND membership.tenant_id=report_set.tenant_id
      JOIN official_usage_versions version
        ON version.id=membership.version_id AND version.tenant_id=membership.tenant_id
          AND version.kind=membership.kind AND version.deleted_at IS NULL
      WHERE version.kind IN ('agents','userAgents')
      ORDER BY version.id,report_set.accepted_at DESC,report_set.id DESC
    ), evidence AS MATERIALIZED (
      SELECT version.id AS version_id,version.set_id,version.accepted_at,version.kind,
        row.ordinal,
        (fact.row_data->>'agentId') COLLATE "C" AS agent_id,
        (fact.row_data->>'agentName') COLLATE "C" AS agent_name,
        (fact.row_data->>'creatorType') COLLATE "C" AS creator_type,
        left(nullif(fact.row_data->>'lastActivityDateUtc',''),10) AS activity_date,
        (fact.row_data->>'responsesSentToUsers')::numeric>0 AS has_responses
      FROM retained_versions version
      JOIN official_usage_version_rows row
        ON row.version_id=version.id AND row.tenant_id=version.tenant_id AND row.kind=version.kind
      JOIN official_usage_row_facts fact
        ON fact.tenant_id=row.tenant_id AND fact.kind=row.kind AND fact.payload_hash=row.payload_hash
    ), all_agents AS (
      SELECT agent_id,bool_or(has_responses) AS has_responses,
        bool_or(has_responses AND activity_date BETWEEN $5::text AND $6::text) AS active,
        min(activity_date) AS earliest_activity,max(activity_date) AS latest_activity
      FROM evidence GROUP BY agent_id
    ), matching_evidence AS MATERIALIZED (
      SELECT * FROM evidence
      WHERE ($2::text IS NULL OR activity_date >= $2)
        AND ($3::text IS NULL OR activity_date <= $3)
        AND ($4::text IS NULL OR strpos(lower(agent_id),lower($4))>0 OR strpos(lower(agent_name),lower($4))>0)
    ), matching_agents AS MATERIALIZED (
      SELECT agent_id,
        array_agg(DISTINCT creator_type ORDER BY creator_type) AS creator_types,
        bool_or(has_responses) AS has_responses,max(activity_date) AS last_activity,
        count(DISTINCT version_id)::int AS observation_count
      FROM matching_evidence GROUP BY agent_id
    ), latest_evidence AS (
      SELECT DISTINCT ON (agent_id) agent_id,agent_name,set_id,accepted_at
      FROM matching_evidence
      ORDER BY agent_id,accepted_at DESC,set_id DESC,
        CASE WHEN kind='agents' THEN 0 ELSE 1 END,
        activity_date DESC NULLS LAST,agent_name,version_id,ordinal
    ), page AS MATERIALIZED (
      SELECT agent.agent_id,latest.agent_name,agent.creator_types,agent.has_responses,agent.last_activity,
        agent.observation_count,latest.set_id,latest.accepted_at
      FROM matching_agents agent JOIN latest_evidence latest USING (agent_id)
      ORDER BY ${order}
      LIMIT $7 OFFSET $8
    )
    SELECT coalesce((SELECT revision FROM official_usage_state WHERE tenant_id=$1),1)::text AS revision,
      (SELECT count(*)::int FROM retained_sets) AS retained_sets,
      count(*)::int AS reported_agents,
      count(*) FILTER (WHERE has_responses)::int AS used_agents,
      count(*) FILTER (WHERE active)::int AS active_agents,
      count(*) FILTER (WHERE latest_activity IS NULL)::int AS undated_agents,
      min(earliest_activity) AS earliest_activity,max(latest_activity) AS latest_activity,
      (SELECT count(*)::int FROM matching_agents) AS agent_count,
      coalesce((SELECT jsonb_agg(jsonb_build_object(
        'agentId',agent_id,'agentName',agent_name,'creatorTypes',creator_types,
        'hasResponses',has_responses,'lastActivityDateUtc',last_activity,
        'observationCount',observation_count,'latestSetId',set_id,
        'latestAcceptedAt',to_char(accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ) ORDER BY ${order}) FROM page),'[]'::jsonb) AS agents
    FROM all_agents`;
}
