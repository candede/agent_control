import { afterEach, describe, expect, it, vi } from "vitest";
import { tenant } from "../auth/authFoundationTestSupport.js";
import { createJobConfirmation, JobRepository } from "../db/jobs.js";
import { AuditLog } from "../services/auditLog.js";
import { setupAuditOriginHttp as setup, closeAuditOriginHttp as close } from "./auditOriginHttpTestSupport.js";
vi.hoisted(() => {
  delete process.env.TENANTS_JSON_FILE;
  process.env.TENANTS_JSON = JSON.stringify([{ tenantId: "11111111-1111-1111-1111-111111111111",
    clientId: "22222222-2222-2222-2222-222222222222", clientSecret: "synthetic-only", domains: ["example.invalid"],
    integration: { clientId: "33333333-3333-3333-3333-333333333333", audience: "22222222-2222-2222-2222-222222222222", scope: "AgentControl.Access" } }]);
});
afterEach(close);
describe.sequential("same registered HTTP route origin parity", () => {
  it("uses identical audit methods/defaults/filter errors and private DTOs for verified web and exact-audience delegated callers", async () => {
    const results: unknown[] = [];
    for (const transport of ["webapp", "mcp"] as const) {
      const { actor, scope, request, database } = await setup(transport);
      await new AuditLog(scope, database).startEvent({ id: "historical-event", operationId: "same-operation", scope: "single",
        action: "block", targetBlockedState: true, agentId: "same-target", actor, requestPath: "/api/agents/block",
        startedAt: "2026-09-01T00:00:00.000Z" });
      const response = await request("/audit/events?originChannel=unknown");
      expect(response.status, await response.clone().text()).toBe(200);
      const body = await response.json(); expect(body.count).toBe(1); expect(body.value[0].origin.channel).toBe("unknown");
      results.push(body);
      const exported = await request("/audit/events/export.csv", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: ["historical-event"] }) });
      if (transport === "webapp") {
        expect(exported.status).toBe(200);
        const csv = await exported.text();
        expect(csv).toContain("originChannel,originIntegrationClientId");
        expect(csv).toContain("historical-event");
        expect(csv).toContain("unknown");
        expect((await new AuditLog(scope, database).listEvents({ action: "export-administrative-audit" }))[0].origin.channel).toBe("webapp");
      } else expect(exported.status).toBe(403);
      for (const path of ["/audit/events?originChannel=actor", "/audit/events?originClientId=bad%00label", "/audit/events?originChannel=mcp&originChannel=webapp"]) {
        const bad = await request(path); expect(bad.status).toBe(400);
        expect((await bad.json()).code).toBe("invalid_action_origin");
      }
      await close();
    }
    expect(results[0]).toEqual(results[1]);
  });
  it("executes one actual local control write per identical independent synthetic prestate, keeping initiating history separate from current origin", async () => {
    const effects: unknown[] = [];
    for (const transport of ["webapp", "mcp"] as const) {
      const { actor, scope, request, database } = await setup(transport);
      const jobs = new JobRepository(database), log = new AuditLog(scope, database);
      const intent = { actor, action: "block" as const, scope: "bulk" as const, requestPath: "/api/agents/block",
        targets: [{ id: "same-target", displayName: "Same target", prestate: { kind: "block" as const, isBlocked: false } }] };
      const job = await jobs.submit(scope, { ...intent, confirmationHash: createJobConfirmation(intent).confirmationHash, idempotencyKey: "same-key" });
      // Separate freshly initialized DBs contain the same accepted synthetic intent.
      const response = await request(`/agents/bulk-jobs/${job.id}/cancel`, { method: "POST" });
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({ status: "cancelled", origin: { channel: "unknown" } });
      const events = await log.listEvents({ action: "cancel-control" });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ status: "succeeded", actor: { homeAccountId: actor.homeAccountId }, origin: { channel: transport,
        integrationClientId: transport === "mcp" ? tenant.integration!.clientId : tenant.clientId } });
      if (transport === "mcp") expect(events[0].origin.client.name).toEqual({ value: "=1+1", evidence: "reported" });
      expect((await log.listEvents({ action: "block" }))[0].origin.channel).toBe("unknown");
      const settled = (await jobs.get(job.id, scope))!;
      effects.push({ total: settled.total, completed: settled.completed, cancelled: settled.cancelled, queued: settled.queued });
      expect(effects.at(-1)).toEqual({ total: 1, completed: 1, cancelled: 1, queued: 0 });
      expect((await database.query("SELECT count(*)::int AS count FROM job_attempts")).rows[0].count).toBe(0);
      if (transport === "webapp") {
        const missingCsrf = await request(`/agents/bulk-jobs/${job.id}/cancel`, { method: "POST", headers: { "X-CSRF-Token": "" } });
        expect(missingCsrf.status).toBe(403);
      }
      await close();
    }
    expect(effects[0]).toEqual(effects[1]);
  });
});
