import { randomUUID } from "node:crypto";
import type pg from "pg";
import { digest } from "../src/db/dataBounds.js";
import type { OfficialUsageReportKind } from "../src/types/officialReportRecords.js";

export async function seedReportSet(database: pg.Pool, tenant: string, number: number, actor = "importing-admin",
  rowCounts: Partial<Record<OfficialUsageReportKind, number>> = {}) {
  if (process.env.AGENT_CONTROL_ISOLATED_TESTS !== "1") throw new Error("fixture_only");
  if (Object.values(rowCounts).some(count => !Number.isInteger(count) || count < 0 || count > 100000)) throw new Error("fixture_row_count");
  const id = randomUUID();
  const versions = {} as Record<OfficialUsageReportKind, string>;
  await database.query(`INSERT INTO official_usage_sets(id,tenant_id,bundle_id,actor_principal_id,period_provenance)
    VALUES($1,$2,$3,$4,'activity_range')`, [id, tenant, randomUUID(), actor]);
  for (const kind of ["agents", "userAgents", "users"] as const) {
    const artifact = randomUUID(), version = randomUUID();
    await database.query(`INSERT INTO official_usage_artifacts(id,tenant_id,kind,file_hash,parser_version,schema_version)
      VALUES($1,$2,$3,$4,'1','fixture')`, [artifact, tenant, kind, digest(`${id}:${kind}`)]);
    await database.query(`INSERT INTO official_usage_versions(id,tenant_id,artifact_id,staging_id,kind,content_hash,
      period_provenance,source_as_of_provenance,source_freshness,row_count,accepted_by)
      VALUES($1,$2,$3,$4,$5,$6,'activity_range','absent','unknown',$8,$7)`,
    [version, tenant, artifact, randomUUID(), kind, digest(`${number}:${kind}`), actor, rowCounts[kind] ?? 0]);
    await database.query("INSERT INTO official_usage_set_versions(set_id,tenant_id,kind,version_id) VALUES($1,$2,$3,$4)", [id, tenant, kind, version]);
    versions[kind] = version;
  }
  await database.query("UPDATE official_usage_sets SET complete=true,accepted_at=clock_timestamp(),content_hash=$2 WHERE id=$1", [id, digest(id)]);
  return { id, versions };
}

export async function seedUserFact(database: pg.Pool, tenant: string, version: string, ordinal: number, username: string, responses: number) {
  const row = JSON.stringify({ username, displayName: username, numberOfAgentsUsed: responses ? 1 : 0, agentResponsesReceived: responses });
  await database.query(`INSERT INTO official_usage_row_facts(tenant_id,kind,payload_hash,row_data,first_observed_at,
    identity_key,username,display_name,responses,agents_used)
    VALUES($1,'users',official_usage_payload_hash($2::jsonb),$2::jsonb,clock_timestamp(),$3,$3,$3,$4,$5)
    ON CONFLICT DO NOTHING`, [tenant, row, username, responses, responses ? 1 : 0]);
  await database.query(`INSERT INTO official_usage_version_rows(version_id,tenant_id,kind,ordinal,payload_hash)
    VALUES($1,$2,'users',$3,official_usage_payload_hash($4::jsonb))`, [version, tenant, ordinal, row]);
}

export async function seedDisjointReportUnion(database: pg.Pool, tenant: string, count: number) {
  if (!Number.isInteger(count) || count < 1 || count > 100000) throw new Error("fixture_row_count");
  const set = await seedReportSet(database, tenant, 1, "importing-admin", { agents: count, userAgents: count, users: count });
  for (const kind of ["agents", "userAgents", "users"] as const) {
    for (let first = 0; first < count; first += 250) {
      await database.query(`WITH batch AS MATERIALIZED (
        SELECT n,CASE $2::text
          WHEN 'agents' THEN jsonb_build_object('agentId','agents-report-'||n,'agentName','Agents report '||n,
            'creatorType','Declarative','activeUsersLicensed',1,'activeUsersUnlicensed',0,'responsesSentToUsers',1)
          WHEN 'userAgents' THEN jsonb_build_object('agentId','agent-'||n,'agentName','Agent '||n,
            'creatorType','Declarative','username','bridge-'||lpad(n::text,5,'0'),'responsesSentToUsers',1)
          ELSE jsonb_build_object('username','user-'||lpad(n::text,5,'0'),'displayName','User '||n,
            'numberOfAgentsUsed',1,'agentResponsesReceived',1) END AS row_data
        FROM generate_series($3::int,$4::int) n
      ), inserted AS (
        INSERT INTO official_usage_row_facts(tenant_id,kind,payload_hash,row_data,first_observed_at,
          identity_key,agent_id,username,agent_name,display_name,creator_type,responses,agents_used,licensed_users,unlicensed_users)
        SELECT $1,$2,official_usage_payload_hash(row_data),row_data,clock_timestamp(),
          lower(normalize(row_data->>'username',NFKC)),row_data->>'agentId',row_data->>'username',
          row_data->>'agentName',row_data->>'displayName',row_data->>'creatorType',1,
          (row_data->>'numberOfAgentsUsed')::bigint,(row_data->>'activeUsersLicensed')::bigint,
          (row_data->>'activeUsersUnlicensed')::bigint FROM batch RETURNING payload_hash
      ) INSERT INTO official_usage_version_rows(version_id,tenant_id,kind,ordinal,payload_hash)
        SELECT $5,$1,$2,n,inserted.payload_hash FROM batch JOIN inserted ON inserted.payload_hash=official_usage_payload_hash(batch.row_data)`,
      [tenant, kind, first, Math.min(first + 249, count - 1), set.versions[kind]]);
    }
  }
  return set;
}
