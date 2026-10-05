import { afterAll,beforeAll,describe,expect,it } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "../../scripts/testDatabase.js";
import { directoryRecord,generationInput } from "../../scripts/largeTenantFixtures.js";
import { DataGenerations,type GenerationLease } from "./dataGenerations.js";
import { verifySchema } from "./schema.js";

const kinds = ["plans","inventory"] as const;
type Kind = (typeof kinds)[number];

describe("atomic set-based child insert fences",() => {
  let fixture: Awaited<ReturnType<typeof testDatabase>>,store: DataGenerations;
  beforeAll(async () => { fixture = await testDatabase();store = new DataGenerations(fixture.runtime); },30_000);
  afterAll(async () => { await fixture?.close(); });
  const begin = async (kind: Kind) => {
    const input = generationInput();
    input.scope.principalId = randomUUID();
    if (kind==="inventory") input.scope.source = "inventory_packages";
    const lease = await store.begin(input);
    if (kind==="plans") await store.append(lease,"directory",0,[directoryRecord("parent",{ plan_count: 250 })]);
    else await fixture.runtime.query(`INSERT INTO inventory_keys(generation_id,scope_id,tenant_id,identity,schema_version,content_hash)
      VALUES($1,$2,$3,'parent',1,repeat('a',64))`,[lease.id,lease.scopeId,lease.tenantId]);
    return { lease,jobId: input.jobId };
  };
  const statement = (kind: Kind) => kind==="plans"
    ? `INSERT INTO directory_service_plan_rows(generation_id,scope_id,tenant_id,identity,user_id,plan_id,
        schema_version,content_hash,service,display_name,state)
      SELECT generation,scope,tenant,'plan-'||ordinal,'parent','plan-'||ordinal,version,repeat('a',64),'service','Plan','enabled'
        FROM jsonb_to_recordset($1::jsonb) r(generation uuid,scope uuid,tenant text,ordinal int,version int)`
    : `INSERT INTO inventory_facts(generation_id,scope_id,tenant_id,identity,ordinal,schema_version,kind,value)
      SELECT generation,scope,tenant,'parent',ordinal,version,'child','value'
        FROM jsonb_to_recordset($1::jsonb) r(generation uuid,scope uuid,tenant text,ordinal int,version int)`;
  const rows = (lease: GenerationLease,count = 250,version = 1) => Array.from({ length: count },(_,ordinal) =>
    ({ generation: lease.id,scope: lease.scopeId,tenant: lease.tenantId,ordinal,version }));
  const table = (kind: Kind) => kind==="plans" ? "directory_service_plan_rows" : "inventory_facts";
  const count = async (kind: Kind,leases: GenerationLease[]) => Number((await fixture.runtime.query(
    `SELECT count(*) AS count FROM ${table(kind)} WHERE generation_id=ANY($1::uuid[])`,[leases.map(lease => lease.id)])).rows[0].count);

  it.each(kinds)("fences one complete 250-child %s insert once without removing row constraints",async kind => {
    const { lease } = await begin(kind),client = await fixture.runtime.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(`EXPLAIN(ANALYZE,BUFFERS,WAL,SETTINGS,FORMAT JSON) ${statement(kind)}`,[JSON.stringify(rows(lease))]);
      const plan = result.rows[0]["QUERY PLAN"][0] as { Triggers: Array<{ "Trigger Name": string;Calls: number }>; "Execution Time": number };
      expect(plan.Triggers.filter(value => value["Trigger Name"]==="child_insert_fence").map(value => value.Calls)).toEqual([1]);
      expect(plan.Triggers.some(value => value["Trigger Name"].startsWith("RI_ConstraintTrigger") && value.Calls===250)).toBe(true);
      process.stdout.write("CHILD_INSERT_FENCE_PROOF "+JSON.stringify({ kind,rows: 250,plan })+"\n");
      await client.query("COMMIT");
      expect(await count(kind,[lease])).toBe(250);
      await expect(fixture.runtime.query(`DELETE FROM ${table(kind)} WHERE generation_id=$1`,[lease.id]))
        .rejects.toThrow(kind==="plans" ? "data_record_immutable" : "inventory_content_pinned");
      await store.abort(lease);
      await expect(fixture.runtime.query(`DELETE FROM ${table(kind)} WHERE generation_id=$1`,[lease.id]))
        .resolves.toMatchObject({ rowCount: 250 });
    } finally { await client.query("ROLLBACK");client.release();await store.abort(lease); }
  });
  it.each(kinds.flatMap(kind => ["validating","cancelled","lease","scope","session"].map(fence => ({ kind,fence }))))(
    "rolls back every $kind child when one generation fails its $fence fence",async ({ kind,fence }) => {
      const good = (await begin(kind)).lease,bad = (await begin(kind)).lease;
      try {
        if (fence==="validating") await fixture.runtime.query("UPDATE data_generations SET state='validating' WHERE id=$1",[bad.id]);
        if (fence==="cancelled") await store.abort(bad,true);
        if (fence==="lease") await fixture.runtime.query("UPDATE data_generations SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[bad.id]);
        if (fence==="scope") await fixture.runtime.query("UPDATE data_scope_epochs SET epoch=epoch+1 WHERE id=$1",[bad.scopeId]);
        if (fence==="session") await fixture.runtime.query("UPDATE data_scope_epochs SET session_epoch=session_epoch+1 WHERE id=$1",[bad.scopeId]);
        await expect(fixture.runtime.query(statement(kind),[JSON.stringify([...rows(good,2),...rows(bad,2)])]))
          .rejects.toThrow("data_writer_fenced");
        expect(await count(kind,[good,bad])).toBe(0);
      } finally { await store.abort(good);await store.abort(bad); }
    });
  it("retains exact child schema and composite ownership checks",async () => {
    const { lease } = await begin("plans");
    try {
      await expect(fixture.runtime.query(statement("plans"),[JSON.stringify([...rows(lease,1),{ ...rows(lease,1,2)[0],ordinal: 1 }])]))
        .rejects.toThrow("data_schema_version");
      await expect(fixture.runtime.query(statement("plans"),[JSON.stringify([{ ...rows(lease,1)[0],tenant: "other-tenant" }])]))
        .rejects.toMatchObject({ code: "23503" });
      expect(await count("plans",[lease])).toBe(0);
    } finally { await store.abort(lease); }
  });
  it.each(["epoch","expired"])("retains inventory worker input %s fences",async reason => {
    const { lease,jobId } = await begin("inventory");
    try {
      await fixture.runtime.query(`INSERT INTO inventory_worker_pins(worker_id,scope_id,tenant_id,baseline_id,revision,epoch,expires_at)
        VALUES($1,$2,$3,$4,1,$5,clock_timestamp()+($6::int*interval '1 second'))`,
      [jobId,lease.scopeId,lease.tenantId,lease.id,reason==="epoch" ? "1" : "0",reason==="expired" ? -1 : 60]);
      await expect(fixture.runtime.query(statement("inventory"),[JSON.stringify(rows(lease,2))])).rejects.toThrow("data_writer_fenced");
      expect(await count("inventory",[lease])).toBe(0);
    } finally {
      await fixture.runtime.query("DELETE FROM inventory_worker_pins WHERE worker_id=$1",[jobId]);await store.abort(lease);
    }
  });
  it("fails readiness when either a statement fence or the immutable row fence is disabled",async () => {
    await verifySchema(fixture.runtime);
    const client = await fixture.operator.connect();
    try {
      for (const [relation,trigger,error] of [
        ["directory_service_plan_rows","child_insert_fence","data_child_insert_fence_schema"],
        ["inventory_facts","inventory_immutable","inventory_schema_guards"],
      ]) {
        await client.query("BEGIN");
        await client.query(`ALTER TABLE ${relation} DISABLE TRIGGER ${trigger}`);
        await expect(verifySchema(client)).rejects.toThrow(error);
        await client.query("ROLLBACK");
      }
    } finally { await client.query("ROLLBACK");client.release(); }
  });
});
