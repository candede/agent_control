import { afterAll,beforeAll,describe,expect,it } from "vitest";
import { generationInput } from "../../scripts/largeTenantFixtures.js";
import { testDatabase } from "../../scripts/testDatabase.js";
import { DataGenerations,type GenerationLease } from "./dataGenerations.js";
import { verifySchema } from "./schema.js";

describe("inventory exact-key collation",() => {
  let fixture: Awaited<ReturnType<typeof testDatabase>>,lease: GenerationLease;
  const identities = ["agent","Agent","agent-\u00e9","agent-e\u0301"];
  beforeAll(async () => {
    fixture = await testDatabase();
    const input = generationInput();
    input.scope.source = "inventory_packages";
    lease = await new DataGenerations(fixture.runtime).begin(input);
    await fixture.runtime.query(`INSERT INTO inventory_keys(generation_id,scope_id,tenant_id,identity,schema_version,content_hash)
      SELECT $1,$2,$3,identity,1,repeat('a',64) FROM unnest($4::text[]) identity`,
    [lease.id,lease.scopeId,lease.tenantId,identities]);
    await fixture.runtime.query(`INSERT INTO inventory_facts(generation_id,scope_id,tenant_id,identity,schema_version,ordinal,kind,value)
      SELECT generation_id,scope_id,tenant_id,identity,1,0,'child',identity FROM inventory_keys WHERE generation_id=$1`,[lease.id]);
  },30_000);
  afterAll(async () => { await fixture?.close(); });

  it("stores distinct exact keys with validated child ownership constraints",async () => {
    const constraints = () => fixture.runtime.query(`SELECT conname,convalidated FROM pg_constraint
      WHERE confrelid='inventory_keys'::regclass ORDER BY conname`);
    const before = (await constraints()).rows;
    await verifySchema(fixture.runtime);
    expect((await constraints()).rows).toEqual(before);
    expect(before.length).toBeGreaterThan(0);
    expect(before.every(row => row.convalidated)).toBe(true);
    for (const table of ["inventory_keys","inventory_facts"]) {
      const saved = await fixture.runtime.query(`SELECT identity FROM ${table} WHERE generation_id=$1`,[lease.id]);
      expect(saved.rows.map(row => row.identity).sort()).toEqual([...identities].sort());
    }
    for (const [tenant,identity] of [[lease.tenantId,"missing"],["other-tenant",identities[0]]]) {
      await expect(fixture.runtime.query(`INSERT INTO inventory_facts(
        generation_id,scope_id,tenant_id,identity,schema_version,ordinal,kind,value)
        VALUES($1,$2,$3,$4,1,1,'child','value')`,[lease.id,lease.scopeId,tenant,identity]))
        .rejects.toMatchObject({ code: "23503" });
    }
  });

  it("uses identity as an index condition even with initially sparse statistics",async () => {
    const client = await fixture.runtime.connect();
    try {
      await client.query("BEGIN; SET LOCAL enable_seqscan=off");
      const result = await client.query(`EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)
        SELECT 1 FROM ONLY inventory_keys WHERE generation_id=$1 AND scope_id=$2 AND tenant_id=$3 AND identity=$4`,
      [lease.id,lease.scopeId,lease.tenantId,identities[0]]);
      const plan = result.rows[0]["QUERY PLAN"][0].Plan;
      expect(plan["Index Cond"]).toContain("identity =");
      expect(plan["Actual Rows"]).toBe(1);
      expect(plan["Rows Removed by Filter"] ?? 0).toBe(0);
    } finally { await client.query("ROLLBACK");client.release(); }
  });
});
