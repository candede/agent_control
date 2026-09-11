import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { auditMetadata, AuditLog } from "./auditLog.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let audit: AuditLog;
const scope = { tenantId: "tenant-1", principalId: "principal-1" };
const actor = { tenantId: scope.tenantId, homeAccountId: scope.principalId, username: "fixture@example.invalid", displayName: "Fixture" };
beforeAll(async () => { fixture = await testDatabase(); audit = new AuditLog(scope, fixture.runtime); });
afterAll(async () => { await fixture?.close(); });

describe("PostgreSQL audit projection", () => {
  it("retains bounded official export lineage but never exported rows", () => {
    expect(auditMetadata({ source: "official_usage", reportSetId: "set-1", reportingStart: "2026-09-01",
      reportingEnd: "2026-09-07", resultingCount: 1, rows: [{ username: "private" }] })).toEqual({
      source: "official_usage", reportSetId: "set-1", reportingStart: "2026-09-01", reportingEnd: "2026-09-07", resultingCount: 1,
    });
  });
  it("appends outcome events without changing the started row", async () => {
    const started = await audit.startEvent({ operationId: "operation-1", scope: "single", action: "block", targetBlockedState: true, agentId: "package-1", actor, requestPath: "/api/agents/package-1/block", metadata: { source: "test", accessToken: "must-not-persist" } });
    const completed = await audit.completeEvent(started.id, { status: "succeeded" });
    expect(await audit.getEvent(started.id)).toMatchObject({ ...completed, metadata: { source: "test" } });
    const rows = await fixture.runtime.query("SELECT status,metadata FROM audit_events WHERE event_id=$1 ORDER BY observed_at", [started.id]);
    expect(rows.rows.map(row => row.status)).toEqual(["started", "succeeded"]);
    expect(JSON.stringify(rows.rows)).not.toContain("must-not-persist");
    expect(await audit.countEvents({ operationIdPrefix: "operation-1" })).toBe(1);
  });
  it("retains nullable block state for access actions and bounded failure metadata", async () => {
    const event = await audit.startEvent({ operationId: "access_100%", scope: "bulk", action: "update-installation", agentId: "package-2", actor, requestPath: "/api/agents/access" });
    await audit.completeEvent(event.id, { status: "failed", message: "Denied", errorCode: "denied", metadata: { previousCount: 2, raw: { secret: "discard" } } });
    const result = await audit.listEvents({ search: "100%", status: "failed" });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ metadata: { previousCount: 2 }, message: "Denied" });
    expect(result[0]).not.toHaveProperty("targetBlockedState");
  });
  it("filters before counts, pagination and reads", async () => {
    const otherPrincipal = new AuditLog({ ...scope, principalId: "other" }, fixture.runtime);
    const otherTenant = new AuditLog({ ...scope, tenantId: "other" }, fixture.runtime);
    expect(await otherPrincipal.listEvents()).toEqual([]);
    expect(await otherTenant.countEvents()).toBe(0);
    const events = await audit.listEvents();
    expect(await otherPrincipal.getEvent(events[0].id)).toBeUndefined();
    expect(await audit.listEvents({ limit: 1, offset: 1 })).toHaveLength(1);
    await expect(audit.startEvent({ operationId: "bad", scope: "single", action: "block", targetBlockedState: true, agentId: "package-1", actor: { ...actor, tenantId: "other" }, requestPath: "/bad" })).rejects.toThrow("scope");
  });
});