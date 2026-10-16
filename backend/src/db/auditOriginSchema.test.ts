import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { verifySchema } from "./schema.js";
import { unknownOrigin } from "../types/actionOrigin.js";
import { AuditLog } from "../services/auditLog.js";
import { withActionOrigin } from "../services/actionOrigin.js";

const origin = { ...unknownOrigin, channel: "webapp" as const,
  integrationClientId: "22222222-2222-2222-2222-222222222222", requestId: randomUUID() };

describe("current audit origin schema", () => {
  it("preserves initiating attribution through lifecycle completion, filters and export", async () => {
    const fixture = await testDatabase();
    try {
      await verifySchema(fixture.runtime);
      const log = new AuditLog({ tenantId: "tenant", principalId: "home" }, fixture.runtime);
      const event = await log.startEvent({ id: randomUUID(), operationId: "origin", scope: "single", action: "block",
        targetBlockedState: true, agentId: "target",
        actor: { tenantId: "tenant", homeAccountId: "home", username: "actor", displayName: "Actor" },
        requestPath: "/api/agents/block", origin });
      for (const bad of [{ ...origin, channel: "fake" }, { ...origin, actor: "override" },
        { ...origin, client: { ...origin.client, name: { value: "\u202e", evidence: "reported" } } }]) {
        expect((await fixture.runtime.query("SELECT audit_origin_valid($1::jsonb) AS valid", [bad])).rows[0].valid).toBe(false);
      }
      await expect(log.startEvent({ ...event, origin: unknownOrigin })).rejects.toThrow("immutable");
      const same = await withActionOrigin(unknownOrigin, () => log.completeEvent(event.id, { status: "succeeded" }));
      expect(same.origin).toEqual(origin);
      expect((await log.listEvents({ originChannel: "webapp" })).map(row => row.id)).toContain(event.id);
      expect((await log.getExportEvents([event.id]))[0].origin).toEqual(origin);
      await expect(fixture.runtime.query("UPDATE audit_events SET origin=$1", [unknownOrigin])).rejects.toMatchObject({ code: "42501" });
    } finally { await fixture.close(); }
  });

  it.each(["function", "index", "grant"])("rejects current structural/grant drift: %s", async kind => {
    const fixture = await testDatabase();
    try {
      if (kind === "function") await fixture.operator.query(
        "CREATE OR REPLACE FUNCTION audit_origin_valid(origin jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT true'");
      if (kind === "index") {
        await fixture.operator.query("DROP INDEX audit_events_origin_channel");
        await fixture.operator.query("CREATE INDEX audit_events_origin_channel ON audit_events(tenant_id)");
      }
      if (kind === "grant") await fixture.operator.query("GRANT UPDATE ON audit_events TO agentcontrol_app");
      await expect(verifySchema(fixture.runtime)).rejects.toThrow("audit_origin_schema_invalid");
    } finally { await fixture.close(); }
  });
});
