import type pg from "pg";
import { describe, expect, it } from "vitest";
import { bootstrap, migrate } from "../../scripts/database.js";
import { fixturePassword, testDatabase } from "../../scripts/testDatabase.js";
import { migrations, verifySchema } from "./schema.js";

type HuntingRow = {
  snapshot_id: string;
  projection_version: number;
  row_data: Record<string, unknown>;
};

async function saveRow(database: pg.Pool, source: "AgentsInfo" | "CloudAppEvents",
  projection: number, payload: Record<string, unknown>) {
  const result = await database.query<{ snapshot_id: string }>(`
    WITH job AS (
      INSERT INTO defender_hunting_jobs(
        id,tenant_id,authorization_principal_id,result_scope_id,result_scope_kind,token_mode,
        template_id,query_version,idempotency_key,request_hash,filters,local_request_id)
      VALUES(gen_random_uuid(),'tenant','reader','reader','principal','delegated',$1,$2,
        gen_random_uuid()::text,repeat('a',64),'{}',gen_random_uuid())
      RETURNING id
    ), snapshot AS (
      INSERT INTO defender_hunting_snapshots(
        id,job_id,tenant_id,result_scope_id,result_scope_kind,template_id,source_table,query_version,
        filters,requested_start,requested_end,result_complete,no_data,provider_row_count,stored_row_count,byte_count)
      SELECT gen_random_uuid(),job.id,'tenant','reader','principal',$1,$3,$2,'{}',
        '2026-09-09T10:00:00Z','2026-09-09T11:00:00Z',true,false,1,1,1024 FROM job
      RETURNING id
    )
    INSERT INTO defender_hunting_rows(
      snapshot_id,row_ordinal,tenant_id,result_scope_id,result_scope_kind,source_table,projection_version,row_data)
    SELECT snapshot.id,0,'tenant','reader','principal',$3,$2,$4::jsonb FROM snapshot
    RETURNING snapshot_id`,
  [source === "AgentsInfo" ? "agents_inventory" : "agent_activity", projection, source, payload]);
  return result.rows[0].snapshot_id;
}

describe("Defender legacy activity projection repair", () => {
  it("upgrades populated legacy rows without changing current projections, query versions or prior checksums", async () => {
    const fixture = await testDatabase(false);
    try {
      await bootstrap(fixture.operator, fixturePassword);
      await migrate(fixture.operator, migrations.filter(step => step.version <= 18));
      const legacyIds: string[] = [];
      for (const actionType of ["InvokeAgent", "InferenceCall", "ExecuteToolByMCPServer"]) {
        legacyIds.push(await saveRow(fixture.operator, "CloudAppEvents", 1, {
          projectionVersion: 1, sourceTable: "CloudAppEvents", actionType,
          actorUserKey: `${actionType}-actor`, actorUserId: `${actionType}@example.invalid`,
          operation: actionType === "InvokeAgent" ? "invoke_agent" : actionType === "InferenceCall" ? "chat" : "execute_tool",
          parentSpanId: null, errorType: null, contentAvailable: false,
        }));
      }
      await saveRow(fixture.operator, "AgentsInfo", 1, {
        projectionVersion: 1, sourceTable: "AgentsInfo",
        ownerCount: null, sharedWithCount: null, permissionMetadataKeyCount: null, authenticationMetadataKeyCount: null,
      });
      await migrate(fixture.operator, migrations.filter(step => step.version <= 39));
      await saveRow(fixture.operator, "CloudAppEvents", 3, {
        projectionVersion: 3, sourceTable: "CloudAppEvents", actionType: "InvokeAgent",
        humanActorUserObjectId: "current-actor", humanActorUserPrincipalName: null,
        agentUserObjectId: null, agentUserPrincipalName: null, contentAvailable: false,
      });
      await saveRow(fixture.operator, "CloudAppEvents", 2, {
        projectionVersion: 2, sourceTable: "CloudAppEvents", actionType: "InvokeAgent",
        humanActorUserObjectId: "legacy-actor", humanActorUserPrincipalName: null,
        agentUserObjectId: null, agentUserPrincipalName: null, contentAvailable: false,
      });

      const rows = async () => (await fixture.operator.query<HuntingRow>(
        "SELECT snapshot_id,projection_version,row_data FROM defender_hunting_rows ORDER BY snapshot_id",
      )).rows;
      const versions = async () => (await fixture.operator.query(
        "SELECT job.id,job.query_version,snapshot.query_version AS snapshot_query_version FROM defender_hunting_jobs job JOIN defender_hunting_snapshots snapshot ON snapshot.job_id=job.id ORDER BY job.id",
      )).rows;
      const before = await rows();
      const priorVersions = await versions();
      const history = (await fixture.operator.query("SELECT version,checksum FROM schema_migrations ORDER BY version")).rows;
      for (const id of legacyIds) {
        const row = before.find(value => value.snapshot_id === id)!;
        expect(row.projection_version).toBe(2);
        expect(row.row_data.projectionVersion).toBe(1);
        expect(row.row_data.actorUserKey).toBe(`${row.row_data.actionType}-actor`);
        const actorField = row.row_data.actionType === "InvokeAgent" ? "humanActorUserObjectId" : "agentUserObjectId";
        expect(row.row_data[actorField]).toBe(row.row_data.actorUserKey);
      }

      await migrate(fixture.operator);
      await verifySchema(fixture.operator);
      const expected = before.map(row => {
        if (!legacyIds.includes(row.snapshot_id)) return row;
        const payload: Record<string, unknown> = { ...row.row_data, projectionVersion: 2 };
        delete payload.actorUserKey;
        delete payload.actorUserId;
        return { ...row, row_data: payload };
      });
      expect(await rows()).toEqual(expected);
      expect(await versions()).toEqual(priorVersions);
      expect((await fixture.operator.query("SELECT version,checksum FROM schema_migrations WHERE version<=39 ORDER BY version")).rows)
        .toEqual(history);
      await migrate(fixture.operator);
      expect(await rows()).toEqual(expected);
    } finally {
      await fixture.close();
    }
  }, 60_000);
});
