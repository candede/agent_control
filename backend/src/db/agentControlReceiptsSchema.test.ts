import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { verifySchema } from "./schema.js";
import { unknownOrigin } from "../types/actionOrigin.js";

describe("current exact control receipt schema", () => {
  it.each([
    "GRANT TRUNCATE ON agent_control_receipts TO agentcontrol_app",
    "ALTER TABLE agent_control_receipts DROP CONSTRAINT agent_control_receipts_receipt_check, ADD CONSTRAINT agent_control_receipts_receipt_check CHECK (true)",
    "ALTER TABLE agent_control_receipts ALTER COLUMN retained_until SET DEFAULT clock_timestamp()+interval '29 days'",
    "ALTER TABLE agent_control_receipts DISABLE TRIGGER protect_agent_control_receipt",
    "ALTER TABLE agent_control_receipts DROP CONSTRAINT agent_control_receipts_actor_identity_check",
    "ALTER TABLE agent_control_receipts DROP CONSTRAINT agent_control_receipts_actor_identity_check, ADD CONSTRAINT agent_control_receipts_actor_identity_check CHECK (true)",
    "ALTER TABLE agent_control_receipts DROP CONSTRAINT agent_control_receipts_actor_identity_check, ADD CONSTRAINT agent_control_receipts_actor_identity_check CHECK (initiating_actor IS NULL OR (jsonb_typeof(initiating_actor->'tenantId')='string' AND jsonb_typeof(initiating_actor->'homeAccountId')='string') IS TRUE) NOT VALID",
  ])("rejects current constraint/grant drift: %s", async sql => {
    const fixture = await testDatabase();
    try {
      await verifySchema(fixture.runtime);
      await fixture.operator.query(sql);
      await expect(verifySchema(fixture.runtime)).rejects.toThrow("agent_control_receipt_schema_invalid");
    } finally { await fixture.close(); }
  });

  it.each(["tenantId", "homeAccountId"] as const)("rejects JSON-null %s at insertion and first acceptance", async field => {
    const f = await testDatabase(), selection = randomUUID(), id = randomUUID(), actor = {
      tenantId: "private-tenant", homeAccountId: "private-home", username: "actor@example.invalid", displayName: "Actor",
    };
    try {
      await f.runtime.query(`INSERT INTO agent_control_receipts(id,tenant_id,principal_id,authorization_hash,session_epoch,selection_id,confirmation_hash,receipt,expires_at)
        VALUES($1,'private-tenant','private-home',$2,1,$3,$2,$4,clock_timestamp()+interval '10 minutes')`,
      [id, "a".repeat(64), selection, { exact: "intent" }]);
      const invalidActor = { ...actor, [field]: null };
      await expect(f.runtime.query(`UPDATE agent_control_receipts SET accepted_at=clock_timestamp(),idempotency_key='first',
        initiating_actor=$2,origin=$3 WHERE id=$1`, [id, invalidActor, unknownOrigin])).rejects.toThrow("agent_control_receipts_actor_identity_check");
      await expect(f.runtime.query(`INSERT INTO agent_control_receipts(id,tenant_id,principal_id,authorization_hash,session_epoch,selection_id,confirmation_hash,receipt,
        expires_at,accepted_at,idempotency_key,initiating_actor,origin)
        VALUES($1,'private-tenant','private-home',$2,1,$3,$2,$4,clock_timestamp()+interval '10 minutes',clock_timestamp(),'inserted',$5,$6)`,
      [randomUUID(), "a".repeat(64), selection, { exact: "intent" }, invalidActor, unknownOrigin])).rejects.toThrow("agent_control_receipts_actor_identity_check");
      await f.runtime.query("UPDATE agent_control_receipts SET accepted_at=clock_timestamp(),idempotency_key='first',initiating_actor=$2,origin=$3 WHERE id=$1",
        [id, actor, unknownOrigin]);
    } finally { await f.close(); }
  });

  it("enforces immutable exact receipt and first accepted actor/origin in SQL", async () => {
    const f = await testDatabase(), id = randomUUID(), selection = randomUUID(), actor = {
      tenantId: "private-tenant", homeAccountId: "private-home", username: "actor@example.invalid", displayName: "Actor",
    };
    try {
      await f.runtime.query(`INSERT INTO agent_control_receipts(id,tenant_id,principal_id,authorization_hash,session_epoch,selection_id,confirmation_hash,receipt,expires_at)
        VALUES($1,'private-tenant','private-home',$2,1,$3,$2,$4,clock_timestamp()+interval '10 minutes')`,
      [id, "a".repeat(64), selection, { exact: "intent" }]);
      await expect(f.runtime.query("UPDATE agent_control_receipts SET receipt=$2 WHERE id=$1", [id, { exact: "replacement" }])).rejects.toThrow("immutable");
      await f.runtime.query("UPDATE agent_control_receipts SET accepted_at=clock_timestamp(),idempotency_key='first',initiating_actor=$2,origin=$3 WHERE id=$1", [id, actor, unknownOrigin]);
      await expect(f.runtime.query("UPDATE agent_control_receipts SET origin=$2 WHERE id=$1", [id, { ...unknownOrigin, channel: "webapp" }])).rejects.toThrow("immutable");
      await expect(f.runtime.query("UPDATE agent_control_receipts SET initiating_actor=$2 WHERE id=$1", [id, { ...actor, displayName: "Later" }])).rejects.toThrow("immutable");
    } finally { await f.close(); }
  });
});
