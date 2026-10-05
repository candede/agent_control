import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,describe,expect,it } from "vitest";
import type pg from "pg";
import { testDatabase } from "../../scripts/testDatabase.js";
import { seedDisjointReportUnion,seedReportSet } from "../../scripts/officialReportFixtures.js";
import { completeReportVersionSql,readableReportVersionSql } from "./reportCapacitySchema.js";
import { verifyReportMembershipCounts,verifyReportMembershipCountsSchema } from "./reportMembershipCountsSchema.js";

describe("transactional official-report membership counts",() => {
  let fixture: Awaited<ReturnType<typeof testDatabase>>;
  beforeAll(async () => { fixture = await testDatabase(); },30_000);
  afterAll(async () => { await fixture?.close(); });
  const count = async (database: Pick<pg.Pool,"query">,id: string) => Number((await database.query(
    "SELECT COALESCE((SELECT row_count FROM official_usage_membership_counts WHERE version_id=$1),0)::text AS n",[id])).rows[0].n);
  const complete = async (database: Pick<pg.Pool,"query">,id: string) => (await database.query(`SELECT
    ${readableReportVersionSql("v.id","v.tenant_id","v.kind","v.row_count")} AS readable,
    ${completeReportVersionSql("v.id","v.tenant_id","v.kind","v.row_count")} AS physical
    FROM official_usage_versions v WHERE v.id=$1`,[id])).rows[0];
  async function rollback(work: (client: pg.PoolClient) => Promise<void>) {
    const client = await fixture.operator.connect();
    try { await client.query("BEGIN");await work(client); }
    finally { try { await client.query("ROLLBACK"); } finally { client.release(); } }
  }

  it("counts a whole insert once while retaining each membership FK and uses indexed read integrity",async () => {
    const tenant = randomUUID(),source = await seedDisjointReportUnion(fixture.operator,tenant,250);
    const target = await seedReportSet(fixture.operator,tenant,2,"synthetic",{ users: 250 });
    const plan = (await fixture.operator.query(`EXPLAIN(ANALYZE,BUFFERS,WAL,SETTINGS,FORMAT JSON)
      INSERT INTO official_usage_version_rows(version_id,tenant_id,kind,ordinal,payload_hash)
      SELECT $1,tenant_id,kind,ordinal,payload_hash FROM official_usage_version_rows WHERE version_id=$2`,
    [target.versions.users,source.versions.users])).rows[0]["QUERY PLAN"];
    expect(plan[0].Triggers.find((row: { "Trigger Name": string }) => row["Trigger Name"]==="official_membership_count_insert").Calls).toBe(1);
    expect(plan[0].Triggers.filter((row: { "Constraint Name"?: string }) => row["Constraint Name"])
      .every((row: { Calls: number }) => row.Calls===250)).toBe(true);
    expect(await count(fixture.runtime,target.versions.users)).toBe(250);
    expect(await complete(fixture.runtime,target.versions.users)).toEqual({ readable: true,physical: true });
    await rollback(async client => {
      await client.query("SET LOCAL jit=off; SET LOCAL enable_seqscan=off");
      const read = (await client.query(`EXPLAIN(ANALYZE,BUFFERS,WAL,SETTINGS,FORMAT JSON)
        SELECT ${readableReportVersionSql("$1","$2","$3","$4")} AS complete`,
      [target.versions.users,tenant,"users",250])).rows[0]["QUERY PLAN"];
      const membershipScans: Record<string,unknown>[] = [];
      const visit = (node: Record<string,unknown>) => {
        if (node["Relation Name"]==="official_usage_version_rows") membershipScans.push(node);
        for (const child of (node.Plans ?? []) as Record<string,unknown>[]) visit(child);
      };
      visit(read[0].Plan);
      expect(JSON.stringify(read)).toContain("official_usage_membership_counts_pkey");
      expect(membershipScans.every(node => node["Actual Loops"]===0)).toBe(true);
      process.stdout.write(JSON.stringify({ contract: "official-report-membership-count",rows: 250,insertPlan: plan,readPlan: read })+"\n");
    });
    await verifyReportMembershipCountsSchema(fixture.runtime);
    await verifyReportMembershipCounts(fixture.operator);
  });

  it("preserves exact known zero and rejects header-count corruption without recounting memberships",async () => {
    const tenant = randomUUID(),set = await seedReportSet(fixture.operator,tenant,1);
    expect(await complete(fixture.runtime,set.versions.users)).toEqual({ readable: true,physical: true });
    await expect(fixture.operator.query("UPDATE official_usage_versions SET row_count=1 WHERE id=$1",[set.versions.users]))
      .rejects.toThrow("official usage version is immutable");
    const incomplete = await seedReportSet(fixture.operator,tenant,2,"synthetic",{ users: 1 });
    expect(await complete(fixture.runtime,incomplete.versions.users)).toEqual({ readable: false,physical: false });
  });

  it("tracks privileged row moves and deletes, and rolls back both data and counts atomically",async () => {
    const tenant = randomUUID(),source = await seedDisjointReportUnion(fixture.operator,tenant,3);
    const target = await seedReportSet(fixture.operator,tenant,2);
    await rollback(async client => {
      await client.query("UPDATE official_usage_version_rows SET version_id=$2 WHERE version_id=$1 AND ordinal=0",
        [source.versions.users,target.versions.users]);
      expect(await count(client,source.versions.users)).toBe(2);
      expect(await count(client,target.versions.users)).toBe(1);
      expect(await complete(client,source.versions.users)).toEqual({ readable: false,physical: false });
      expect(await count(fixture.runtime,source.versions.users)).toBe(3);
      await client.query("DELETE FROM official_usage_version_rows WHERE version_id=$1",[target.versions.users]);
      expect(await count(client,target.versions.users)).toBe(0);
      await verifyReportMembershipCounts(client);
    });
    expect(await count(fixture.runtime,source.versions.users)).toBe(3);
    expect(await count(fixture.runtime,target.versions.users)).toBe(0);
    await verifyReportMembershipCounts(fixture.operator);
  });

  it("does not charge a partly valid insert that fails a foreign key",async () => {
    const tenant = randomUUID(),set = await seedDisjointReportUnion(fixture.operator,tenant,1);
    await expect(fixture.operator.query(`INSERT INTO official_usage_version_rows(version_id,tenant_id,kind,ordinal,payload_hash)
      SELECT requested.version_id,row.tenant_id,row.kind,1,row.payload_hash FROM official_usage_version_rows row
        CROSS JOIN (VALUES($1::uuid),($2::uuid)) requested(version_id) WHERE row.version_id=$1 AND row.ordinal=0`,
    [set.versions.users,randomUUID()])).rejects.toMatchObject({ code: "23503" });
    expect(await count(fixture.runtime,set.versions.users)).toBe(1);
    await verifyReportMembershipCounts(fixture.operator);
  });

  it("rejects incomplete facts before they can invalidate counted memberships",async () => {
    const tenant = randomUUID(),set = await seedDisjointReportUnion(fixture.operator,tenant,1);
    await rollback(async client => {
      await expect(client.query("UPDATE official_usage_row_facts SET identity_key=NULL WHERE tenant_id=$1 AND kind='users'",[tenant]))
        .rejects.toMatchObject({ code: "23514", constraint: "official_usage_typed_fact" });
    });
    expect(await count(fixture.runtime,set.versions.users)).toBe(1);
    expect(await complete(fixture.runtime,set.versions.users)).toEqual({ readable: true,physical: true });
    await verifyReportMembershipCounts(fixture.operator);
  });

  it("cascades version cleanup without leaving count rows or changing other versions",async () => {
    const tenant = randomUUID(),set = await seedDisjointReportUnion(fixture.operator,tenant,3);
    await fixture.operator.query("DELETE FROM official_usage_set_versions WHERE version_id=$1",[set.versions.users]);
    await fixture.operator.query("DELETE FROM official_usage_versions WHERE id=$1",[set.versions.users]);
    expect(await count(fixture.runtime,set.versions.users)).toBe(0);
    expect(await count(fixture.runtime,set.versions.agents)).toBe(3);
    expect((await fixture.runtime.query("SELECT 1 FROM official_usage_membership_counts WHERE version_id=$1",[set.versions.users])).rowCount).toBe(0);
    await verifyReportMembershipCounts(fixture.operator);
  });

  it("detects missing counters and restores them only by rolling back the corrupting transaction",async () => {
    const tenant = randomUUID(),set = await seedDisjointReportUnion(fixture.operator,tenant,3);
    await rollback(async client => {
      await client.query("DELETE FROM official_usage_membership_counts WHERE version_id=$1",[set.versions.users]);
      await expect(verifyReportMembershipCounts(client)).rejects.toThrow("official_membership_count_mismatch");
    });
    expect(await count(fixture.runtime,set.versions.users)).toBe(3);
    await verifyReportMembershipCounts(fixture.operator);
  });

  it.each(["insert","delete","update"])("fails readiness if its %s statement counter is disabled",async operation => {
    await rollback(async client => {
      await client.query(`ALTER TABLE official_usage_version_rows DISABLE TRIGGER official_membership_count_${operation}`);
      await expect(verifyReportMembershipCountsSchema(client)).rejects.toThrow("official_membership_count_schema");
    });
  });

  it("fails readiness when runtime cannot read the maintained count",async () => {
    await rollback(async client => {
      await client.query("REVOKE SELECT ON official_usage_membership_counts FROM agentcontrol_app");
      await expect(verifyReportMembershipCountsSchema(client)).rejects.toThrow("official_membership_count_schema");
    });
  });

  it.each(["INSERT","UPDATE","DELETE","TRUNCATE","INSERT(version_id)","UPDATE(row_count)","EXECUTE"])(
    "keeps the derived count closed to runtime privilege drift: %s",async privilege => {
      await rollback(async client => {
        await client.query(privilege==="EXECUTE"
          ? "GRANT EXECUTE ON FUNCTION official_usage_membership_count() TO agentcontrol_app"
          : `GRANT ${privilege} ON official_usage_membership_counts TO agentcontrol_app`);
        await expect(verifyReportMembershipCountsSchema(client)).rejects.toThrow("official_membership_count_schema");
      });
    });
});
