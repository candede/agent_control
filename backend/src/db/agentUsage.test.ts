import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { retain } from "../../scripts/database.js";
import { testDatabase } from "../../scripts/testDatabase.js";
import { AgentUsageService, combineAgentInventoryRevision } from "../services/agentUsage.js";
import { AuditLog } from "../services/auditLog.js";
import type { AgentUsageAssociationRemoval } from "../types/agentUsage.js";
import { AgentUsageRepository } from "./agentUsage.js";
import {
  deleteUsageSet, newUsageScope, publishUsageReports, saveUsageInventory, usageAudit, usageIntent,
} from "./agentUsageTestSupport.js";
import { OfficialUsageRepository } from "./officialUsage.js";
import { readUnifiedInventoryRevision } from "./unifiedInventoryRevision.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let service: AgentUsageService;

beforeAll(async () => {
  fixture = await testDatabase();
  service = new AgentUsageService(fixture.runtime);
}, 60_000);
afterAll(async () => { await fixture?.close(); });
afterEach(() => vi.restoreAllMocks());

describe("persisted reviewed agent usage", () => {
  it("provides explicit unavailable metrics and current-record-only candidate browsing", async () => {
    const scope = newUsageScope();
    const records = await saveUsageInventory(fixture.runtime, scope);
    const result = await service.project(scope, records);
    expect(result.context.availability).toBe("never_imported");
    expect([...result.summaries.values()]).toEqual(records.map(() => ({
      status: "unavailable", reportSetId: null, responses: null, activeUsers: null, lastActivityDateUtc: null, associations: [],
    })));
    expect(await service.candidates(scope, records[0].id, { offset: 0, limit: 50 })).toMatchObject({ value: [], count: 0 });
    await expect(service.candidates({ ...scope, principalId: "other" }, records[0].id, { offset: 0, limit: 50 }))
      .rejects.toMatchObject({ status: 404, code: "agent_not_found" });
  });

  it("returns bounded Agents-only candidates without user rows or automatic association", async () => {
    const scope = newUsageScope();
    const records = await saveUsageInventory(fixture.runtime, scope);
    await publishUsageReports(fixture.runtime, scope);
    const result = await service.candidates(scope, records[0].id, { search: "reported", offset: 1, limit: 2 });
    expect(result).toMatchObject({ count: 4, offset: 1, limit: 2, context: { availability: "active" } });
    expect(result.value.map(value => value.agentId)).toEqual(["Report-B", "Report-Missing"]);
    expect(result.value.every(value => value.associated === false)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/CaseUser|caseuser|Shared|ZeroUser|BridgeUser|username|displayName/);
    expect((await service.project(scope, records)).summaries.get(records[0].id))
      .toMatchObject({ status: "unlinked", responses: null, activeUsers: null });
    expect(await associationCount(scope.tenantId)).toBe(0);
  });

  it("commits merged report metrics and success audits atomically without changing inventory authority", async () => {
    const scope = newUsageScope();
    const records = await saveUsageInventory(fixture.runtime, scope);
    await publishUsageReports(fixture.runtime, scope);
    const before = await fixture.runtime.query("SELECT to_jsonb(source) AS value FROM unified_agent_sources source WHERE tenant_id=$1 ORDER BY native_id", [scope.tenantId]);
    const initialRevision = await service.revision(scope);
    const one = await service.attach(scope, records[0].id, await usageIntent(fixture.runtime, scope), usageAudit(scope));
    expect(one.context.revision).not.toBe(initialRevision);
    await service.attach(scope, records[0].id, await usageIntent(fixture.runtime, scope, "Report-B", { source: "graph_packages", packageId: "Package-B" }), usageAudit(scope));
    const result = await service.project(scope, records);
    expect(result.summaries.get(records[0].id)).toMatchObject({
      status: "linked", responses: 30, activeUsers: 3, lastActivityDateUtc: "2026-09-18T00:00:00.000Z",
    });
    expect(result.summaries.get(records[0].id)!.associations.map(value => value.reportAgentId)).toEqual(["Report-A", "Report-B"]);
    expect(result.summaries.get(records[1].id)).toMatchObject({ status: "unlinked", responses: null, activeUsers: null });
    expect((await service.candidates(scope, records[0].id, { offset: 0, limit: 50 })).value.filter(value => value.associated).map(value => value.agentId))
      .toEqual(["Report-A", "Report-B"]);
    expect((await fixture.runtime.query("SELECT to_jsonb(source) AS value FROM unified_agent_sources source WHERE tenant_id=$1 ORDER BY native_id", [scope.tenantId])).rows)
      .toEqual(before.rows);
    const audit = await new AuditLog(scope, fixture.runtime).listEvents({ action: "associate-agent-usage" });
    expect(audit).toHaveLength(2);
    expect(audit.every(event => event.status === "succeeded" && event.metadata?.selection === "admin_reviewed"
      && event.metadata?.reportSetId === one.context.reportSet?.id && !event.targetBlockedState)).toBe(true);
    expect(audit.every(event => /^[a-f0-9]{64}$/.test(String(event.metadata?.reportAgentHash)))).toBe(true);
  });

  it("distinguishes explicit zero from absent companion evidence after persistence", async () => {
    const scope = newUsageScope();
    const records = await saveUsageInventory(fixture.runtime, scope);
    await publishUsageReports(fixture.runtime, scope);
    await service.attach(scope, records[0].id, await usageIntent(fixture.runtime, scope, "Report-Zero"), usageAudit(scope));
    expect((await service.project(scope, records)).summaries.get(records[0].id))
      .toMatchObject({ responses: 0, activeUsers: 0, lastActivityDateUtc: null });
    await service.attach(scope, records[0].id, await usageIntent(fixture.runtime, scope, "Report-Missing"), usageAudit(scope));
    expect((await service.project(scope, records)).summaries.get(records[0].id)).toMatchObject({ responses: 1, activeUsers: null });
    await expect(service.attach(scope, records[0].id, await usageIntent(fixture.runtime, scope, "Bridge-Only"), usageAudit(scope)))
      .rejects.toMatchObject({ code: "usage_report_agent_not_found" });
  });

  it("shares only source-qualified associations across private viewer UUIDs and isolates tenants", async () => {
    const scope = newUsageScope();
    const records = await saveUsageInventory(fixture.runtime, scope);
    await publishUsageReports(fixture.runtime, scope);
    await service.attach(scope, records[0].id, await usageIntent(fixture.runtime, scope), usageAudit(scope));
    const viewer = { ...scope, principalId: "another-viewer" };
    const otherRecords = await saveUsageInventory(fixture.runtime, viewer, [{ packages: ["Package-A"] }, { packages: ["Package-C"] }]);
    expect(otherRecords[0].id).not.toBe(records[0].id);
    const otherProjection = await service.project(viewer, otherRecords);
    expect(otherProjection.summaries.get(otherRecords[0].id)).toMatchObject({ status: "linked", responses: 10, activeUsers: 2 });
    expect(otherProjection.summaries.get(otherRecords[1].id)).toMatchObject({ status: "unlinked", responses: null });
    const otherTenant = newUsageScope();
    const foreignRecords = await saveUsageInventory(fixture.runtime, otherTenant, [{ packages: ["Package-A"] }]);
    await publishUsageReports(fixture.runtime, otherTenant);
    expect((await service.project(otherTenant, foreignRecords)).summaries.get(foreignRecords[0].id))
      .toMatchObject({ status: "unlinked", responses: null });
    await expect(service.candidates(viewer, records[0].id, { offset: 0, limit: 50 })).rejects.toMatchObject({ code: "agent_not_found" });
    await expect(service.attach(otherTenant, records[0].id, await usageIntent(fixture.runtime, otherTenant), usageAudit(otherTenant)))
      .rejects.toMatchObject({ code: "agent_not_found" });
  });

  it("uses the current Power Platform environment/GUID contract but not opaque-ID or package case folding", async () => {
    const scope = newUsageScope();
    const nativeId = "abcdefab-1234-4567-89ab-abcdefabcdef";
    const records = await saveUsageInventory(fixture.runtime, scope, [
      { packages: [], native: { nativeId, environmentId: "ENV-A" } },
      { packages: [], native: { nativeId: nativeId.toUpperCase(), environmentId: "ENV-B" } },
      { packages: [nativeId] },
      { packages: [], native: { nativeId: "Opaque-ID", environmentId: null } },
      { packages: [], native: { nativeId: "opaque-id", environmentId: null } },
    ]);
    await publishUsageReports(fixture.runtime, scope);
    const target = { source: "power_platform" as const, nativeId: nativeId.toUpperCase(), environmentId: "env-a" };
    await service.attach(scope, records[0].id, await usageIntent(fixture.runtime, scope, "Report-A", target), usageAudit(scope));
    await service.attach(scope, records[3].id, await usageIntent(fixture.runtime, scope, "Report-B",
      { source: "power_platform", nativeId: "Opaque-ID", environmentId: null }), usageAudit(scope));
    const result = await service.project(scope, records);
    expect(records.map(record => result.summaries.get(record.id)?.responses)).toEqual([10, null, null, 20, null]);
    const viewer = { ...scope, principalId: "pp-viewer" };
    const shared = await saveUsageInventory(fixture.runtime, viewer, [{ packages: [], native: { nativeId: nativeId.toUpperCase(), environmentId: "env-a" } }]);
    expect((await service.project(viewer, shared)).summaries.get(shared[0].id)).toMatchObject({ status: "linked", responses: 10 });
    await expect(service.attach(scope, records[0].id, await usageIntent(fixture.runtime, scope, "Report-Missing",
      { ...target, environmentId: "env-b" }), usageAudit(scope))).rejects.toMatchObject({ code: "usage_target_mismatch" });
    await expect(service.attach(scope, records[2].id, await usageIntent(fixture.runtime, scope, "Report-Missing",
      { source: "graph_packages", packageId: nativeId.toUpperCase() }), usageAudit(scope))).rejects.toMatchObject({ code: "usage_target_mismatch" });
  });

  it("rejects conflicting reassignment, supports exact same-target retries, and requires explicit authorized removal", async () => {
    const scope = newUsageScope();
    const records = await saveUsageInventory(fixture.runtime, scope);
    await publishUsageReports(fixture.runtime, scope);
    const initial = await usageIntent(fixture.runtime, scope);
    await service.attach(scope, records[0].id, initial, usageAudit(scope));
    await expect(service.attach(scope, records[0].id, initial, usageAudit(scope))).rejects.toMatchObject({ code: "agent_usage_changed" });
    const current = await usageIntent(fixture.runtime, scope);
    await service.attach(scope, records[0].id, current, usageAudit(scope));
    expect(await service.revision(scope)).toBe(current.expectedUsageRevision);
    await expect(service.attach(scope, records[0].id, { ...current, target: { source: "graph_packages", packageId: "Package-B" } }, usageAudit(scope)))
      .rejects.toMatchObject({ code: "usage_association_conflict" });
    await expect(service.remove(scope, records[1].id, removal(current), usageAudit(scope))).rejects.toMatchObject({ code: "usage_association_not_found" });
    await service.remove(scope, records[0].id, removal(current), usageAudit(scope));
    expect(await service.revision(scope)).not.toBe(initial.expectedUsageRevision);
    await service.attach(scope, records[1].id, await usageIntent(fixture.runtime, scope, "Report-A", { source: "graph_packages", packageId: "Package-C" }), usageAudit(scope));
    const result = await service.project(scope, records);
    expect(result.summaries.get(records[0].id)).toMatchObject({ status: "unlinked" });
    expect(result.summaries.get(records[1].id)).toMatchObject({ status: "linked", responses: 10 });
  });

  it("serializes concurrent reviewed writes and retains one winner plus one failed audit", async () => {
    const scope = newUsageScope();
    const records = await saveUsageInventory(fixture.runtime, scope);
    await publishUsageReports(fixture.runtime, scope);
    const otherAdmin = { ...scope, principalId: "concurrent-administrator" };
    const otherRecords = await saveUsageInventory(fixture.runtime, otherAdmin, [{ packages: ["Package-C"] }]);
    const initial = await usageIntent(fixture.runtime, scope);
    const otherIntent = await usageIntent(fixture.runtime, otherAdmin, "Report-A", { source: "graph_packages", packageId: "Package-C" });
    const settled = await Promise.allSettled([
      service.attach(scope, records[0].id, initial, usageAudit(scope)),
      service.attach(otherAdmin, otherRecords[0].id, otherIntent, usageAudit(otherAdmin)),
    ]);
    expect(settled.map(value => value.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(settled.find((value): value is PromiseRejectedResult => value.status === "rejected")?.reason)
      .toMatchObject({ code: "agent_usage_changed" });
    expect(await associationCount(scope.tenantId)).toBe(1);
    const events = [...await new AuditLog(scope, fixture.runtime).listEvents(), ...await new AuditLog(otherAdmin, fixture.runtime).listEvents()];
    expect(events.map(event => event.status).sort()).toEqual(["failed", "succeeded"]);
  });

  it("rejects stale combined inventory revisions and source targets that disappeared", async () => {
    const scope = newUsageScope();
    const records = await saveUsageInventory(fixture.runtime, scope);
    await publishUsageReports(fixture.runtime, scope);
    const input = await usageIntent(fixture.runtime, scope);
    await expect(service.attach(scope, records[0].id, { ...input, expectedInventoryRevision: "f".repeat(64) }, usageAudit(scope)))
      .rejects.toMatchObject({ code: "inventory_changed" });
    await fixture.operator.query("UPDATE package_inventory_snapshots SET is_current=false WHERE tenant_id=$1 AND principal_id=$2",
      [scope.tenantId, scope.principalId]);
    await expect(service.attach(scope, records[0].id, input, usageAudit(scope))).rejects.toMatchObject({ code: "agent_not_found" });
    expect(await associationCount(scope.tenantId)).toBe(0);
  });

  it("rolls back associations and their revision if the transaction's success audit fails", async () => {
    const scope = newUsageScope();
    const records = await saveUsageInventory(fixture.runtime, scope);
    await publishUsageReports(fixture.runtime, scope);
    const input = await usageIntent(fixture.runtime, scope);
    const complete = AuditLog.prototype.completeEvent;
    vi.spyOn(AuditLog.prototype, "completeEvent").mockImplementation(function (id, update) {
      if (update.status === "succeeded") return Promise.reject(new Error("Simulated audit persistence failure"));
      return complete.call(this, id, update);
    });
    await expect(service.attach(scope, records[0].id, input, usageAudit(scope))).rejects.toThrow("audit persistence");
    expect(await associationCount(scope.tenantId)).toBe(0);
    expect(await service.revision(scope)).toBe(input.expectedUsageRevision);
    expect((await new AuditLog(scope, fixture.runtime).listEvents()).map(value => value.status)).toEqual(["failed"]);
  });

  it("never carries associations into a newly accepted report set and fences old export revisions", async () => {
    const scope = newUsageScope();
    const records = await saveUsageInventory(fixture.runtime, scope);
    const first = await publishUsageReports(fixture.runtime, scope);
    await service.attach(scope, records[0].id, await usageIntent(fixture.runtime, scope), usageAudit(scope));
    const oldIntent = await usageIntent(fixture.runtime, scope);
    const second = await publishUsageReports(fixture.runtime, scope, 11);
    expect(second.setId).not.toBe(first.setId);
    const result = await service.project(scope, records);
    expect(result.context.reportSet?.id).toBe(second.setId);
    expect(result.summaries.get(records[0].id)).toMatchObject({ status: "unlinked", responses: null });
    const combined = combineAgentInventoryRevision(await readUnifiedInventoryRevision(scope, fixture.runtime), await service.revision(scope));
    expect(combined).not.toBe(oldIntent.expectedInventoryRevision);
    await expect(service.remove(scope, records[0].id, removal(oldIntent), usageAudit(scope))).rejects.toMatchObject({ code: "agent_usage_changed" });
    expect(await associationCount(scope.tenantId)).toBe(1);
    const reports = new OfficialUsageRepository(fixture.runtime);
    const selection = await reports.previewSetOperation(scope, "select", first.setId);
    await reports.confirmSetOperation(scope, selection.id, {
      operation: "select", setId: first.setId, expectedRevision: selection.expectedRevision, confirmationHash: selection.confirmationHash,
    });
    expect((await service.project(scope, records)).summaries.get(records[0].id)).toMatchObject({ status: "linked", responses: 10 });
  });

  it("immediately cascades soft deletion and cannot publish or mutate the deleted set", async () => {
    const scope = newUsageScope();
    const records = await saveUsageInventory(fixture.runtime, scope);
    const report = await publishUsageReports(fixture.runtime, scope);
    await service.attach(scope, records[0].id, await usageIntent(fixture.runtime, scope), usageAudit(scope));
    const old = await usageIntent(fixture.runtime, scope);
    await deleteUsageSet(fixture.runtime, scope, report.setId);
    expect(await associationCount(scope.tenantId)).toBe(0);
    expect(await service.revision(scope)).not.toBe(old.expectedUsageRevision);
    const result = await service.project(scope, records);
    expect(result.context).toMatchObject({ availability: "deleted", reportSet: null, lineages: [] });
    expect(result.summaries.get(records[0].id)).toMatchObject({ status: "unavailable", responses: null, activeUsers: null });
    await expect(service.attach(scope, records[0].id, old, usageAudit(scope))).rejects.toMatchObject({ code: "agent_usage_changed" });
  });

  it.each(["set", "version", "artifact"])("fences %s expiry without waiting for retention", async entity => {
    const scope = newUsageScope();
    const records = await saveUsageInventory(fixture.runtime, scope);
    const report = await publishUsageReports(fixture.runtime, scope);
    await service.attach(scope, records[0].id, await usageIntent(fixture.runtime, scope), usageAudit(scope));
    const old = await usageIntent(fixture.runtime, scope);
    if (entity === "set") {
      await fixture.operator.query("UPDATE official_usage_sets SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [report.setId]);
    } else if (entity === "version") {
      await fixture.operator.query("UPDATE official_usage_versions SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND kind='agents'", [scope.tenantId]);
    } else {
      await fixture.operator.query("UPDATE official_usage_artifacts SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND kind='agents'", [scope.tenantId]);
    }
    expect(await service.revision(scope)).not.toBe(old.expectedUsageRevision);
    expect((await service.project(scope, records)).summaries.get(records[0].id)).toMatchObject({ status: "unavailable", responses: null });
    expect((await service.candidates(scope, records[0].id, { offset: 0, limit: 50 })).value).toEqual([]);
    await expect(service.attach(scope, records[0].id, old, usageAudit(scope))).rejects.toMatchObject({ code: "agent_usage_changed" });
    if (entity === "set") {
      const dry = await retain(fixture.operator, { batchSize: 100, dryRun: true });
      expect(dry.affected.agentUsageAssociations).toBeGreaterThan(0);
      expect(await associationCount(scope.tenantId)).toBe(1);
      await retain(fixture.operator, { batchSize: 100 });
      expect(await associationCount(scope.tenantId)).toBe(0);
    }
  });

  it("keeps tenant associations through principal source cleanup but stops resolving absent sources", async () => {
    const scope = newUsageScope();
    const records = await saveUsageInventory(fixture.runtime, scope);
    await publishUsageReports(fixture.runtime, scope);
    await service.attach(scope, records[0].id, await usageIntent(fixture.runtime, scope), usageAudit(scope));
    const viewer = { ...scope, principalId: "retained-viewer" };
    const other = await saveUsageInventory(fixture.runtime, viewer, [{ packages: ["Package-A"] }]);
    await fixture.operator.query("DELETE FROM package_inventory_snapshots WHERE tenant_id=$1 AND principal_id=$2", [scope.tenantId, scope.principalId]);
    expect(await associationCount(scope.tenantId)).toBe(1);
    expect((await service.project(scope, records)).summaries.get(records[0].id)).toMatchObject({ status: "unlinked", responses: null });
    expect((await service.project(viewer, other)).summaries.get(other[0].id)).toMatchObject({ status: "linked", responses: 10 });
  });

  it("holds source and report locks once for the entire saved snapshot", async () => {
    const scope = newUsageScope();
    await saveUsageInventory(fixture.runtime, scope);
    await publishUsageReports(fixture.runtime, scope);
    const repository = new AgentUsageRepository(fixture.runtime);
    await repository.withSnapshot(scope, async client => {
      await repository.readSources(scope, client);
      await repository.read(scope, client);
      const competitor = await fixture.runtime.connect();
      try {
        await competitor.query("BEGIN");
        for (const key of [
          `package-refresh:${scope.tenantId}:${scope.principalId}`, `power-platform:${scope.tenantId}:${scope.principalId}`, `official-usage:${scope.tenantId}`,
        ]) {
          expect((await competitor.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired", [key])).rows[0].acquired).toBe(false);
        }
      } finally {
        await competitor.query("ROLLBACK");
        competitor.release();
      }
    });
  });
});

function removal(input: Awaited<ReturnType<typeof usageIntent>>): AgentUsageAssociationRemoval {
  const { target: _target, ...result } = input;
  return result;
}

async function associationCount(tenantId: string) {
  return (await fixture.runtime.query<{ count: number }>("SELECT count(*)::int AS count FROM agent_usage_associations WHERE tenant_id=$1", [tenantId])).rows[0].count;
}
