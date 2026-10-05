import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "../../scripts/testDatabase.js";
import { verifySchema } from "./schema.js";
import { publishPackageReadback } from "./packageControls.js";
import { capturePackageMutationState } from "../services/packageMutationState.js";
import { allowlistedPackage } from "../services/packageObservation.js";

describe("inventory control receipt schema", () => {
  let fixture: Awaited<ReturnType<typeof testDatabase>>;
  beforeAll(async () => { fixture = await testDatabase(); }, 30_000);
  afterAll(async () => { await fixture?.close(); });
  it("permits control-only receipts with startup grants and rejects inventory snapshots", async () => {
    await verifySchema(fixture.runtime);
    const scope = { tenantId: `cutover-${randomUUID()}`, principalId: randomUUID() };
    const detail = allowlistedPackage({ id: "Opaque-Control-A", displayName: "Current verified control", isBlocked: true });
    const client = await fixture.runtime.connect();
    try {
      await client.query("BEGIN");
      const receipt = await publishPackageReadback(scope, detail, client, null, capturePackageMutationState(detail, "block"));
      await client.query("COMMIT");
      expect((await fixture.runtime.query(`SELECT requested_ids,observation_kind FROM package_inventory_snapshots WHERE id=$1`,
        [receipt])).rows[0]).toEqual({ requested_ids: [detail.id], observation_kind: "block" });
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    await expect(fixture.runtime.query(`INSERT INTO package_inventory_snapshots
      (id,tenant_id,principal_id,token_mode,query_hash,scope_kind,requested_ids,observed_count,total_records,page_count,observation_kind,expires_at)
      VALUES($1,$2,$3,'delegated',$4,'broad','[]',0,0,1,'inventory',clock_timestamp()+interval '1 day')`,
    [randomUUID(), scope.tenantId, scope.principalId, "a".repeat(64)])).rejects.toMatchObject({ code: "23514" });
  });
});
