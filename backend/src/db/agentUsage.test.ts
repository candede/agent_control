import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { retain } from "../../scripts/database.js";
import { testDatabase } from "../../scripts/testDatabase.js";
import { OfficialAgentUsage } from "../services/officialAgentUsage.js";
import { LargeTenantUsersReports } from "../services/largeTenantUsersReports.js";
import { AuditLog } from "../services/auditLog.js";
import type { CandidateAgentUsageMutation } from "../types/officialReportApi.js";
import type { ReportQuery } from "../types/officialReportData.js";
import {
  awaitUsageInventoryExpiry, deleteUsageSet, newUsageScope, publishUsageReports, saveUsageInventory, usageAudit, usageIdentity, usageIntent, type AgentUsageScope,
} from "./agentUsageTestSupport.js";
import { OfficialReportImports } from "./officialReportImports.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let reports: LargeTenantUsersReports, service: OfficialAgentUsage;
beforeAll(async () => {
  fixture = await testDatabase();
  reports = new LargeTenantUsersReports(fixture.runtime, "synthetic-native-agent-usage-read-secret", 35);
  service = new OfficialAgentUsage(reports);
});
afterAll(async () => { await fixture?.close(); });
afterEach(() => vi.restoreAllMocks());

async function selected(scope: AgentUsageScope, query: ReportQuery = {}) {
  const identity = await usageIdentity(fixture.runtime, scope);
  return { identity, selection: await reports.capture(identity, "delegated", "official_agents", query) };
}
async function inventory(scope: AgentUsageScope, records: readonly { id: string }[]) {
  return reports.history.connections.selectedRead(async client =>
    service.inventorySummaries(client, await reports.currentInventoryData(client, scope), records.map(record => record.id)));
}
async function associate(scope: AgentUsageScope, recordId: string, input: CandidateAgentUsageMutation) {
  return service.mutate(await usageIdentity(fixture.runtime, scope), recordId, input, usageAudit(scope).actor);
}
function removal(input: CandidateAgentUsageMutation): CandidateAgentUsageMutation {
  const { target: _target, ...result } = input;
  return result;
}
async function selectSet(scope: AgentUsageScope, setId: string) {
  const imports = new OfficialReportImports(fixture.runtime), identity = await usageIdentity(fixture.runtime, scope);
  return imports.confirm(identity, await imports.confirmPreview(identity, setId, "select"));
}
async function associationCount(tenantId: string) {
  return (await fixture.runtime.query<{ count: number }>("SELECT count(*)::int AS count FROM agent_usage_associations WHERE tenant_id=$1", [tenantId])).rows[0].count;
}
async function sourceRows(tenantId: string) {
  return (await fixture.runtime.query(`SELECT to_jsonb(source) AS value FROM unified_agent_memberships source
    JOIN inventory_memberships m ON m.generation_id=source.generation_id AND m.identity=source.identity
    JOIN inventory_roots root ON root.baseline_id=m.baseline_id AND root.current
      AND m.valid_from_revision<=root.revision AND (m.valid_to_revision IS NULL OR m.valid_to_revision>root.revision)
    WHERE source.tenant_id=$1 ORDER BY source.source_scope_id,source.source_identity LIMIT 250`, [tenantId])).rows;
}

describe("persisted reviewed agent usage through exact native contracts", () => {
  it("projects exact package IDs without association writes or inventory changes and pages associations separately", async () => {
    const scope = newUsageScope();
    const records = await saveUsageInventory(fixture.runtime, scope, [
      { packages: ["Report-A", "Report-B"], native: { nativeId: "Native-A", environmentId: "env-a" } },
      { packages: ["Report-Zero"] }, { packages: ["Report-Missing"] }, { packages: [], native: { nativeId: "Report-A", environmentId: "env-b" } },
    ]);
    await publishUsageReports(fixture.runtime, scope);
    const before = await sourceRows(scope.tenantId);
    expect(before).toHaveLength(6);
    expect(await inventory(scope, records)).toMatchObject([
      { status: "linked", responses: 30, activeUsers: 3, associationCount: 2 },
      { status: "linked", responses: 0, activeUsers: 0 }, { status: "linked", responses: 1, activeUsers: null }, { status: "unlinked", responses: null },
    ]);
    const { identity, selection } = await selected(scope);
    const first = await service.associations(selection.id, identity, records[0].id, { limit: 1 });
    expect(first.value).toMatchObject([{ reportAgentId: "Report-A", basis: "exact_package_id", target: { source: "graph_packages", packageId: "Report-A" } }]);
    expect(first.counts).toEqual({ total: 2, filtered: 2 });
    const second = await service.associations(selection.id, identity, records[0].id, { limit: 1, cursor: first.page.nextCursor! });
    expect(second.value).toMatchObject([{ reportAgentId: "Report-B", basis: "exact_package_id" }]);
    expect(second.page.nextCursor).toBeNull();
    expect(await associationCount(scope.tenantId)).toBe(0);
    expect(await new AuditLog(scope, fixture.runtime).listEvents()).toEqual([]);
    expect(await sourceRows(scope.tenantId)).toEqual(before);
  });

  it("matches newly selected reports without adding overlapping totals and fences mutations against old selections", async () => {
    const scope = newUsageScope(), records = await saveUsageInventory(fixture.runtime, scope, [{ packages: ["Report-A"] }]);
    const first = await publishUsageReports(fixture.runtime, scope, 179), previous = await inventory(scope, records);
    const second = await publishUsageReports(fixture.runtime, scope, 181), current = await inventory(scope, records);
    expect(previous[0]).toMatchObject({ reportSetId: first.setId, responses: 179 });
    expect(current[0]).toMatchObject({ reportSetId: second.setId, responses: 181 });
    await selectSet(scope, first.setId);
    expect((await inventory(scope, records))[0]).toMatchObject({ reportSetId: first.setId, responses: 179 });
    await deleteUsageSet(fixture.runtime, scope, first.setId);
    expect((await inventory(scope, records))[0]).toMatchObject({ status: "unavailable", responses: null });
    expect(await associationCount(scope.tenantId)).toBe(0);
  });

  it("scopes automatic matches to each tenant and viewer's current source evidence", async () => {
    const scope = newUsageScope(), records = await saveUsageInventory(fixture.runtime, scope, [{ packages: ["Report-A"] }],
      { expiresAt: new Date(Date.now() + 3000) });
    await publishUsageReports(fixture.runtime, scope);
    const viewer = { ...scope, principalId: "automatic-viewer" }, other = await saveUsageInventory(fixture.runtime, viewer, [{ packages: ["Report-A"] }]);
    expect(other[0].id).not.toBe(records[0].id);
    expect((await inventory(viewer, other))[0]).toMatchObject({ status: "linked", responses: 10 });
    const foreignScope = newUsageScope(), foreign = await saveUsageInventory(fixture.runtime, foreignScope, [{ packages: ["Report-A"] }]);
    expect((await inventory(foreignScope, foreign))[0]).toMatchObject({ status: "unavailable", responses: null });
    await publishUsageReports(fixture.runtime, foreignScope, 99);
    expect((await inventory(foreignScope, foreign))[0].responses).toBe(99);
    await awaitUsageInventoryExpiry(fixture.runtime, scope);
    expect((await inventory(scope, records))[0]).toMatchObject({ status: "unlinked", responses: null });
    expect((await inventory(viewer, other))[0].responses).toBe(10);
    const { identity, selection } = await selected(scope);
    await expect(service.summaries(selection.id, identity, [records[0].id])).rejects.toMatchObject({ code: "agent_not_found" });
    expect(await associationCount(scope.tenantId)).toBe(0);
  });

  it("returns unavailable nulls without reports and permits candidates only for the current exact record", async () => {
    const scope = newUsageScope(), records = await saveUsageInventory(fixture.runtime, scope);
    const { identity, selection } = await selected(scope);
    const summaries = await service.summaries(selection.id, identity, records.map(record => record.id));
    expect(summaries).toHaveLength(records.length);
    expect(summaries.every(row => row.status === "unavailable" && row.responses === null && row.activeUsers === null
      && row.context.reports.availability === "never_imported" && row.associationCount === 0)).toBe(true);
    expect(await service.candidates(selection.id, identity, records[0].id, {})).toMatchObject({ value: [], counts: { total: 0, filtered: 0 } });
    const other = await selected({ ...scope, principalId: "other" });
    await expect(service.candidates(other.selection.id, other.identity, records[0].id, {})).rejects.toMatchObject({ code: "agent_not_found" });
  });

  it("returns cursor-bounded Agents-only candidates without disclosing user rows or creating associations", async () => {
    const scope = newUsageScope(), records = await saveUsageInventory(fixture.runtime, scope);
    await publishUsageReports(fixture.runtime, scope);
    const { identity, selection } = await selected(scope, { search: "reported", sort: "name", order: "asc" });
    const first = await service.candidates(selection.id, identity, records[0].id, { limit: 1 });
    const page = await service.candidates(selection.id, identity, records[0].id, { limit: 2, cursor: first.page.nextCursor!,
      inventoryRevision: first.context.inventoryRevision });
    expect(page.counts).toEqual({ total: 4, filtered: 4 });
    expect(page.value.map(row => row.agentId)).toEqual(["Report-B", "Report-Missing"]);
    expect(page.value.every(row => !row.associated)).toBe(true);
    expect(JSON.stringify(page)).not.toMatch(/CaseUser|caseuser|Shared|ZeroUser|BridgeUser|username|displayName/);
    expect((await inventory(scope, records))[0]).toMatchObject({ status: "unlinked", responses: null });
    expect(await associationCount(scope.tenantId)).toBe(0);
  });

  it("commits merged metrics and success audits atomically without changing inventory authority", async () => {
    const scope = newUsageScope(), records = await saveUsageInventory(fixture.runtime, scope);
    await publishUsageReports(fixture.runtime, scope);
    const before = await sourceRows(scope.tenantId);
    expect(before).toHaveLength(3);
    const initial = await usageIntent(fixture.runtime, scope);
    const one = await associate(scope, records[0].id, initial);
    expect(one.usageRevision).not.toBe(initial.usageRevision);
    await associate(scope, records[0].id, await usageIntent(fixture.runtime, scope, "Report-B", { source: "graph_packages", packageId: "Package-B" }));
    expect(await inventory(scope, records)).toMatchObject([{ status: "linked", responses: 30, activeUsers: 3, lastActivityDateUtc: "2026-09-18T00:00:00.000Z" },
      { status: "unlinked", responses: null, activeUsers: null }]);
    const { identity, selection } = await selected(scope);
    expect((await service.associations(selection.id, identity, records[0].id, {})).value.map(row => row.reportAgentId)).toEqual(["Report-A", "Report-B"]);
    expect((await service.candidates(selection.id, identity, records[0].id, {})).value.filter(row => row.associated).map(row => row.agentId)).toEqual(["Report-B", "Report-A"]);
    expect(await sourceRows(scope.tenantId)).toEqual(before);
    const audit = await new AuditLog(scope, fixture.runtime).listEvents({ action: "associate-agent-usage" });
    expect(audit).toHaveLength(2);
    expect(audit.every(event => event.status === "succeeded" && event.metadata?.selection === "admin_reviewed"
      && event.metadata.reportSetId === one.reportSetId && !event.targetBlockedState && /^[a-f0-9]{64}$/.test(String(event.metadata.reportAgentHash)))).toBe(true);
    expect(audit.map(event => event.metadata?.targetSelectionHash).sort()).toEqual(["Package-A", "Package-B"].map(nativeId =>
      createHash("sha256").update(JSON.stringify(JSON.stringify(["graph_packages", "", nativeId]))).digest("hex")).sort());
  });

  it("aggregates one hundred exact canonical targets in one bounded query without multiplying shared users", async () => {
    const scope = newUsageScope();
    const records = await saveUsageInventory(fixture.runtime, scope, [
      { packages: ["Report-A", "Report-B"] },
      ...Array.from({ length: 99 }, (_, index) => ({ packages: [`unmatched-${index}`] })),
    ]);
    await publishUsageReports(fixture.runtime, scope);
    await reports.history.connections.selectedRead(async client => {
      const context = await reports.currentInventoryData(client, scope);
      const query = vi.spyOn(client, "query");
      try {
        const summaries = await service.inventorySummaries(client, context, records.map(record => record.id));
        expect(summaries).toHaveLength(100);
        expect(summaries[0]).toMatchObject({ recordId: records[0].id, responses: 30, activeUsers: 3, associationCount: 2 });
        expect(summaries.slice(1).every(summary => summary.status === "unlinked" && summary.responses === null)).toBe(true);
        expect(query).toHaveBeenCalledOnce();
        expect(query.mock.calls[0][1]?.[7]).toHaveLength(100);
        expect(Buffer.byteLength(JSON.stringify(query.mock.calls[0][1]))).toBeLessThanOrEqual(1024 * 1024);
        expect(Buffer.byteLength(JSON.stringify(summaries))).toBeLessThanOrEqual(1024 * 1024);
        await expect(service.inventorySummaries(client, context, [...records.map(record => record.id), records[0].id]))
          .rejects.toMatchObject({ code: "data_exact_ids_limit" });
        await expect(service.inventorySummaries(client, context, [records[0].id, records[0].id.toUpperCase().replace("AGENT:", "agent:")]))
          .rejects.toMatchObject({ code: "data_exact_ids_limit" });
        expect(query).toHaveBeenCalledOnce();
      } finally { query.mockRestore(); }
    });
  });

  it("distinguishes explicit zero from absent companion evidence after persistence", async () => {
    const scope = newUsageScope(), records = await saveUsageInventory(fixture.runtime, scope);
    await publishUsageReports(fixture.runtime, scope);
    await associate(scope, records[0].id, await usageIntent(fixture.runtime, scope, "Report-Zero"));
    expect((await inventory(scope, records))[0]).toMatchObject({ responses: 0, activeUsers: 0, lastActivityDateUtc: null });
    await associate(scope, records[0].id, await usageIntent(fixture.runtime, scope, "Report-Missing"));
    expect((await inventory(scope, records))[0]).toMatchObject({ responses: 1, activeUsers: null });
    await expect(associate(scope, records[0].id, await usageIntent(fixture.runtime, scope, "Bridge-Only"))).rejects.toMatchObject({ code: "usage_report_agent_not_found" });
  });

  it("shares source-qualified associations across private viewer UUIDs but isolates tenants", async () => {
    const scope = newUsageScope(), records = await saveUsageInventory(fixture.runtime, scope);
    await publishUsageReports(fixture.runtime, scope);
    await associate(scope, records[0].id, await usageIntent(fixture.runtime, scope));
    const viewer = { ...scope, principalId: "another-viewer" }, other = await saveUsageInventory(fixture.runtime, viewer, [{ packages: ["Package-A"] }, { packages: ["Package-C"] }]);
    expect(other[0].id).not.toBe(records[0].id);
    expect(await inventory(viewer, other)).toMatchObject([{ status: "linked", responses: 10, activeUsers: 2 }, { status: "unlinked", responses: null }]);
    const foreignScope = newUsageScope(), foreign = await saveUsageInventory(fixture.runtime, foreignScope, [{ packages: ["Package-A"] }]);
    await publishUsageReports(fixture.runtime, foreignScope);
    expect((await inventory(foreignScope, foreign))[0]).toMatchObject({ status: "unlinked", responses: null });
    const otherSelection = await selected(viewer);
    await expect(service.candidates(otherSelection.selection.id, otherSelection.identity, records[0].id, {})).rejects.toMatchObject({ code: "agent_not_found" });
    await expect(associate(foreignScope, records[0].id, await usageIntent(fixture.runtime, foreignScope))).rejects.toMatchObject({ code: "agent_not_found" });
  });

  it("uses environment/GUID normalization but never folds opaque IDs or package IDs", async () => {
    const scope = newUsageScope(), nativeId = "abcdefab-1234-4567-89ab-abcdefabcdef";
    const records = await saveUsageInventory(fixture.runtime, scope, [
      { packages: [], native: { nativeId, environmentId: "ENV-A" } }, { packages: [], native: { nativeId: nativeId.toUpperCase(), environmentId: "ENV-B" } },
      { packages: [nativeId] }, { packages: [], native: { nativeId: "Opaque-ID", environmentId: null } }, { packages: [], native: { nativeId: "opaque-id", environmentId: null } },
    ]);
    await publishUsageReports(fixture.runtime, scope);
    const target = { source: "power_platform" as const, nativeId: nativeId.toUpperCase(), environmentId: "env-a" };
    await associate(scope, records[0].id, await usageIntent(fixture.runtime, scope, "Report-A", target));
    await associate(scope, records[3].id, await usageIntent(fixture.runtime, scope, "Report-B", { source: "power_platform", nativeId: "Opaque-ID", environmentId: null }));
    expect((await inventory(scope, records)).map(row => row.responses)).toEqual([10, null, null, 20, null]);
    const viewer = { ...scope, principalId: "pp-viewer" }, shared = await saveUsageInventory(fixture.runtime, viewer, [{ packages: [], native: { nativeId: nativeId.toUpperCase(), environmentId: "env-a" } }]);
    expect((await inventory(viewer, shared))[0]).toMatchObject({ status: "linked", responses: 10 });
    const valid = await usageIntent(fixture.runtime, scope, "Report-Missing", target);
    await expect(associate(scope, records[0].id, { ...valid, target: { ...target, environmentId: "env-b" } })).rejects.toMatchObject({ code: "usage_target_mismatch" });
    const packageIntent = await usageIntent(fixture.runtime, scope, "Report-Missing", { source: "graph_packages", packageId: nativeId });
    await expect(associate(scope, records[2].id, { ...packageIntent, target: { source: "graph_packages", packageId: nativeId.toUpperCase() } })).rejects.toMatchObject({ code: "usage_target_mismatch" });
  });

  it("requires explicit authorized removal before reassignment while preserving same-target retries", async () => {
    const scope = newUsageScope(), records = await saveUsageInventory(fixture.runtime, scope);
    await publishUsageReports(fixture.runtime, scope);
    const initial = await usageIntent(fixture.runtime, scope);
    await associate(scope, records[0].id, initial);
    await expect(associate(scope, records[0].id, initial)).rejects.toMatchObject({ code: "agent_usage_changed" });
    const current = await usageIntent(fixture.runtime, scope);
    expect((await associate(scope, records[0].id, current)).usageRevision).toBe(current.usageRevision);
    await expect(associate(scope, records[0].id, { ...current, target: { source: "graph_packages", packageId: "Package-B" } })).rejects.toMatchObject({ code: "usage_association_conflict" });
    const wrongOwner = await usageIntent(fixture.runtime, scope, "Report-A", { source: "graph_packages", packageId: "Package-C" });
    await expect(associate(scope, records[1].id, removal(wrongOwner))).rejects.toMatchObject({ code: "usage_association_not_found" });
    await associate(scope, records[0].id, removal(current));
    await associate(scope, records[1].id, await usageIntent(fixture.runtime, scope, "Report-A", { source: "graph_packages", packageId: "Package-C" }));
    expect(await inventory(scope, records)).toMatchObject([{ status: "unlinked" }, { status: "linked", responses: 10 }]);
  });

  it("serializes concurrent reviewed writes with one winner and one failed audit", async () => {
    const scope = newUsageScope(), records = await saveUsageInventory(fixture.runtime, scope);
    await publishUsageReports(fixture.runtime, scope);
    const other = { ...scope, principalId: "concurrent-administrator" }, otherRecords = await saveUsageInventory(fixture.runtime, other, [{ packages: ["Package-C"] }]);
    const initial = await usageIntent(fixture.runtime, scope), otherIntent = await usageIntent(fixture.runtime, other, "Report-A", { source: "graph_packages", packageId: "Package-C" });
    const settled = await Promise.allSettled([associate(scope, records[0].id, initial), associate(other, otherRecords[0].id, otherIntent)]);
    expect(settled.map(value => value.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(settled.find((value): value is PromiseRejectedResult => value.status === "rejected")?.reason).toMatchObject({ code: "agent_usage_changed" });
    expect(await associationCount(scope.tenantId)).toBe(1);
    const audit = [...await new AuditLog(scope, fixture.runtime).listEvents(), ...await new AuditLog(other, fixture.runtime).listEvents()];
    expect(audit.map(row => row.status).sort()).toEqual(["failed", "succeeded"]);
  });

  it("rejects stale exact inventory fingerprints and disappeared sources", async () => {
    const scope = newUsageScope(), records = await saveUsageInventory(fixture.runtime, scope);
    await publishUsageReports(fixture.runtime, scope);
    const input = await usageIntent(fixture.runtime, scope);
    await expect(associate(scope, records[0].id, { ...input, inventoryRevision: "f".repeat(64) })).rejects.toMatchObject({ code: "inventory_changed" });
    await fixture.operator.query(`UPDATE data_scope_epochs SET epoch=epoch+1
      WHERE tenant_id=$1 AND principal_id=$2 AND source='inventory_packages'`, [scope.tenantId, scope.principalId]);
    await expect(associate(scope, records[0].id, input)).rejects.toMatchObject({ code: "agent_not_found" });
    expect(await associationCount(scope.tenantId)).toBe(0);
  });

  it("rolls back associations and their revision when the success audit fails", async () => {
    const scope = newUsageScope(), records = await saveUsageInventory(fixture.runtime, scope);
    await publishUsageReports(fixture.runtime, scope);
    const input = await usageIntent(fixture.runtime, scope), complete = AuditLog.prototype.completeEvent;
    vi.spyOn(AuditLog.prototype, "completeEvent").mockImplementation(function (id, update) {
      return update.status === "succeeded" ? Promise.reject(new Error("Simulated audit persistence failure")) : complete.call(this, id, update);
    });
    await expect(associate(scope, records[0].id, input)).rejects.toThrow("audit persistence");
    expect(await associationCount(scope.tenantId)).toBe(0);
    expect((await usageIntent(fixture.runtime, scope)).usageRevision).toBe(input.usageRevision);
    expect((await new AuditLog(scope, fixture.runtime).listEvents()).map(row => row.status)).toEqual(["failed"]);
  });

  it("never carries associations into a newly accepted set and fences old mutation revisions", async () => {
    const scope = newUsageScope(), records = await saveUsageInventory(fixture.runtime, scope);
    const first = await publishUsageReports(fixture.runtime, scope);
    await associate(scope, records[0].id, await usageIntent(fixture.runtime, scope));
    const old = await usageIntent(fixture.runtime, scope), second = await publishUsageReports(fixture.runtime, scope, 11);
    expect(second.setId).not.toBe(first.setId);
    expect((await inventory(scope, records))[0]).toMatchObject({ reportSetId: second.setId, status: "unlinked", responses: null });
    await expect(associate(scope, records[0].id, removal(old))).rejects.toMatchObject({ code: "agent_usage_changed" });
    expect(await associationCount(scope.tenantId)).toBe(1);
    await selectSet(scope, first.setId);
    expect((await inventory(scope, records))[0]).toMatchObject({ status: "linked", responses: 10 });
  });

  it("immediately cascades deleted associations and invalidates previously captured reads and writes", async () => {
    const scope = newUsageScope(), records = await saveUsageInventory(fixture.runtime, scope), report = await publishUsageReports(fixture.runtime, scope);
    await associate(scope, records[0].id, await usageIntent(fixture.runtime, scope));
    const old = await usageIntent(fixture.runtime, scope);
    await deleteUsageSet(fixture.runtime, scope, report.setId);
    expect(await associationCount(scope.tenantId)).toBe(0);
    const current = await selected(scope), [summary] = await service.summaries(current.selection.id, current.identity, [records[0].id]);
    expect(summary).toMatchObject({ status: "unavailable", responses: null, activeUsers: null, context: { reports: { availability: "deleted", setId: null, lineages: [] } } });
    await expect(associate(scope, records[0].id, old)).rejects.toMatchObject({ code: "selection_invalidated" });
  });

  it.each(["set", "version", "artifact"] as const)("fences %s expiry before retention and honors dry-run collection", async entity => {
    const scope = newUsageScope(), records = await saveUsageInventory(fixture.runtime, scope), report = await publishUsageReports(fixture.runtime, scope);
    await associate(scope, records[0].id, await usageIntent(fixture.runtime, scope));
    const old = await usageIntent(fixture.runtime, scope), identity = await usageIdentity(fixture.runtime, scope);
    // One shared slice visits one tenant; position this fixture at its actual turn before testing rollback.
    if (entity === "set") await fixture.operator.query(`UPDATE data_lifecycle_progress
      SET cursor=jsonb_build_object('step',0,'tenant',coalesce(
        (SELECT max(tenant_id COLLATE "C") FROM official_usage_history_state WHERE tenant_id COLLATE "C"<$1 COLLATE "C"),''))
      WHERE worker='operator'`, [scope.tenantId]);
    if (entity === "set") await fixture.operator.query("UPDATE official_usage_sets SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [report.setId]);
    else await fixture.operator.query(`UPDATE official_usage_${entity === "version" ? "versions" : "artifacts"} SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND kind='agents'`, [scope.tenantId]);
    await expect(service.summaries(old.selectionId, identity, [records[0].id])).rejects.toMatchObject({ code: "selection_invalidated" });
    await expect(associate(scope, records[0].id, old)).rejects.toMatchObject({ code: "selection_invalidated" });
    if (entity === "set") {
      expect((await retain(fixture.operator, { batchSize: 100, dryRun: true })).affected.officialHistoryExpired).toBeGreaterThan(0);
      expect(await associationCount(scope.tenantId)).toBe(1);
      await retain(fixture.operator, { batchSize: 100 });
      expect(await associationCount(scope.tenantId)).toBe(0);
    }
    const current = await selected(scope);
    expect((await service.candidates(current.selection.id, current.identity, records[0].id, {})).value).toEqual([]);
    expect((await inventory(scope, records))[0]).toMatchObject({ status: "unavailable", responses: null });
  });

  it("keeps tenant associations through principal cleanup but stops resolving absent sources", async () => {
    const scope = newUsageScope(), records = await saveUsageInventory(fixture.runtime, scope);
    await publishUsageReports(fixture.runtime, scope);
    await associate(scope, records[0].id, await usageIntent(fixture.runtime, scope));
    const viewer = { ...scope, principalId: "retained-viewer" }, other = await saveUsageInventory(fixture.runtime, viewer, [{ packages: ["Package-A"] }]);
    await saveUsageInventory(fixture.runtime, scope, []);
    expect(await associationCount(scope.tenantId)).toBe(1);
    expect((await inventory(scope, records))[0]).toMatchObject({ status: "unlinked", responses: null });
    expect((await inventory(viewer, other))[0]).toMatchObject({ status: "linked", responses: 10 });
  });

  it("holds source publication locks through the mutation audit and uses repeatable-read summary callbacks", async () => {
    const scope = newUsageScope(), records = await saveUsageInventory(fixture.runtime, scope);
    await publishUsageReports(fixture.runtime, scope);
    const complete = AuditLog.prototype.completeEvent;
    vi.spyOn(AuditLog.prototype, "completeEvent").mockImplementation(async function (id, update) {
      if (update.status === "succeeded") {
        const competitor = await fixture.runtime.connect();
        try {
          await competitor.query("BEGIN");
          expect((await competitor.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired",
            [`data-sync:${scope.tenantId}:${scope.principalId}`])).rows[0].acquired).toBe(false);
          const scopes = (await competitor.query(`SELECT id,source FROM data_scope_epochs WHERE tenant_id=$1 AND principal_id=$2
            AND source IN ('inventory_canonical','inventory_packages','inventory_power_platform') ORDER BY source`,
          [scope.tenantId, scope.principalId])).rows;
          expect(scopes.map(value => value.source)).toEqual(["inventory_canonical", "inventory_packages", "inventory_power_platform"]);
          expect((await competitor.query("SELECT id FROM data_scope_epochs WHERE id=ANY($1::uuid[]) FOR UPDATE SKIP LOCKED",
            [scopes.map(value => value.id)])).rows).toEqual([]);
        } finally { await competitor.query("ROLLBACK"); competitor.release(); }
      }
      return complete.call(this, id, update);
    });
    await associate(scope, records[0].id, await usageIntent(fixture.runtime, scope));
    const current = await selected(scope);
    await reports.read(current.selection.id, current.identity, async (client, context) => {
      expect((await client.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe("repeatable read");
      expect((await service.inventorySummaries(client, context, [records[0].id]))[0].responses).toBe(10);
    });
  });
});
