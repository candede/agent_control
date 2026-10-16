import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "../../scripts/testDatabase.js";
import { verifySchema } from "./schema.js";
import { currentSchemaSql } from "./currentSchema.js";
import { publishPackageReadback } from "./packageControls.js";
import { capturePackageMutationState } from "../services/packageMutationState.js";
import { allowlistedPackage } from "../services/packageObservation.js";

describe("current schema control receipt contract", () => {
  it("defines exact delegated control receipts", () => {
    const table = currentSchemaSql.match(/CREATE TABLE package_inventory_snapshots \([\s\S]*?\n\);/)?.[0];
    const contract = table?.match(/CONSTRAINT package_control_only CHECK \(([\s\S]*?)\)\n  , CONSTRAINT/)?.[1]
      .replace(/\s+/g, " ").trim();
    expect(contract).toBe("observation_kind = ANY(ARRAY[CAST('block' AS text) , CAST('access' AS text)])"
      + " AND token_mode = CAST('delegated' AS text) AND scope_kind = CAST('exact' AS text)"
      + " AND jsonb_array_length(requested_ids) = 1 AND observed_count = 1 AND total_records = 1");
  });
});

describe("current schema control receipt persistence", () => {
  let fixture: Awaited<ReturnType<typeof testDatabase>>;
  beforeAll(async () => { fixture = await testDatabase(); }, 30_000);
  afterAll(async () => { await fixture?.close(); });
  it("permits control-only receipts with startup grants and rejects inventory snapshots", async () => {
    await verifySchema(fixture.runtime);
    const scope = { tenantId: `control-${randomUUID()}`, principalId: randomUUID() };
    const detail = allowlistedPackage({ id: "Opaque-Control-A", displayName: "Current verified control", isBlocked: true });
    const client = await fixture.runtime.connect();
    try {
      await client.query("BEGIN");
      const receipt = await publishPackageReadback(scope, detail, client, null, capturePackageMutationState(detail, "block"));
      await client.query("COMMIT");
      expect((await fixture.runtime.query(`SELECT token_mode,scope_kind,requested_ids,observed_count,total_records,
        page_count,observation_kind,control_state FROM package_inventory_snapshots WHERE id=$1`,
      [receipt])).rows[0]).toEqual({
        token_mode: "delegated", scope_kind: "exact", requested_ids: [detail.id], observed_count: 1, total_records: 1,
        page_count: 1, observation_kind: "block", control_state: { kind: "block", isBlocked: true },
      });
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    await expect(fixture.runtime.query(`INSERT INTO package_inventory_snapshots
      (id,tenant_id,principal_id,token_mode,query_hash,scope_kind,requested_ids,observed_count,total_records,page_count,observation_kind,expires_at)
      VALUES($1,$2,$3,'delegated',$4,'broad','[]',0,0,1,'inventory',clock_timestamp()+interval '1 day')`,
    [randomUUID(), scope.tenantId, scope.principalId, "a".repeat(64)])).rejects.toMatchObject({ code: "23514" });
  });
});
