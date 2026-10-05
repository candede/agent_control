import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { awaitUsageInventoryExpiry, newUsageScope, publishUsageReports, saveUsageInventory, usageAudit, usageIdentity, usageIntent, type AgentUsageScope } from "../db/agentUsageTestSupport.js";
import type { CandidateAgentUsageMutation } from "../types/officialReportApi.js";
import { unifiedAgentRecordId } from "../types/unifiedAgents.js";
import { AuditLog } from "./auditLog.js";
import { OfficialAgentUsage } from "./officialAgentUsage.js";
import { officialAgentUsageMutation } from "./officialAgentUsageInput.js";
import { parseRecordId } from "./agentUsageIdentity.js";
import { LargeTenantUsersReports, reportQuery } from "./largeTenantUsersReports.js";
import * as maintenance from "./maintenance.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let reports: LargeTenantUsersReports, usage: OfficialAgentUsage;
beforeAll(async () => {
  fixture = await testDatabase();
  reports = new LargeTenantUsersReports(fixture.runtime, "synthetic-selected-agent-usage-secret", 35);
  usage = new OfficialAgentUsage(reports);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
afterAll(async () => { await fixture?.close(); });

async function read(scope: AgentUsageScope, ids: readonly string[]) {
  const identity = await usageIdentity(fixture.runtime, scope), selection = await reports.capture(identity, "delegated", "official_agents");
  return usage.summaries(selection.id, identity, ids);
}
async function inventory(scope: AgentUsageScope, ids: readonly string[]) {
  return reports.history.connections.selectedRead(async client => usage.inventorySummaries(client, await reports.currentInventoryData(client, scope), ids));
}
async function mutate(scope: AgentUsageScope, recordId: string, input: CandidateAgentUsageMutation) {
  return usage.mutate(await usageIdentity(fixture.runtime, scope), recordId, input, usageAudit(scope).actor);
}
async function count(scope: AgentUsageScope) {
  return (await fixture.runtime.query("SELECT count(*)::int AS n FROM agent_usage_associations WHERE tenant_id=$1", [scope.tenantId])).rows[0].n;
}

describe("native report-backed exact inventory usage", () => {
  it.each(["name", "guid-fragment", "prefix", "case", "manifest", "app", "asset"] as const)("does not infer an exact package identity from %s", async kind => {
    const scope = newUsageScope(), guid = "11111111-1111-4111-8111-111111111111", packageId = `T_${guid}`;
    const records = await saveUsageInventory(fixture.runtime, scope, [{ packages: [packageId],
      packageFields: { manifestId: guid, appId: guid, assetId: guid } }]);
    const alias = kind === "name" ? `Inventory ${packageId}` : kind === "prefix" ? `P_${guid}` : kind === "case" ? packageId.toLowerCase() : guid;
    await publishUsageReports(fixture.runtime, scope, 10, (_kind, content) => content.replaceAll("Report-A", alias));
    expect((await read(scope, [records[0].id]))[0]).toMatchObject({ status: "unlinked", responses: null, activeUsers: null, associationCount: 0 });
  });

  it.each(["missing", "snapshot", "expired"] as const)("requires current authorized source membership, not %s evidence", async mismatch => {
    const scope = newUsageScope(), records = await saveUsageInventory(fixture.runtime, scope, [{ packages: ["Report-A"] }],
      mismatch === "expired" ? { expiresAt: new Date(Date.now() + 3000) } : {});
    await publishUsageReports(fixture.runtime, scope);
    if (mismatch === "missing") await saveUsageInventory(fixture.runtime, scope, []);
    else if (mismatch === "snapshot") await fixture.operator.query(`UPDATE data_scope_epochs SET epoch=epoch+1
      WHERE tenant_id=$1 AND source='inventory_packages'`, [scope.tenantId]);
    else await awaitUsageInventoryExpiry(fixture.runtime, scope);
    expect((await inventory(scope, [records[0].id]))[0]).toMatchObject({ status: "unlinked", responses: null });
    await expect(read(scope, [records[0].id])).rejects.toMatchObject({ code: "agent_not_found" });
  });

  it.each([true, false])("preserves reviewed overrides without automatic reassignment (authorized target: %s)", async authorized => {
    const scope = newUsageScope(), records = await saveUsageInventory(fixture.runtime, scope, [{ packages: ["Report-A", "Report-B"] }, { packages: ["Package-C"] }]);
    await publishUsageReports(fixture.runtime, scope);
    await mutate(scope, records[1].id, await usageIntent(fixture.runtime, scope, "Report-A", { source: "graph_packages", packageId: "Package-C" }));
    if (!authorized) await saveUsageInventory(fixture.runtime, scope, [{ packages: ["Report-A", "Report-B"] }]);
    expect(await inventory(scope, records.map(record => record.id))).toMatchObject([
      { responses: 20, associationCount: 1 }, authorized ? { responses: 10, associationCount: 1 } : { status: "unlinked", responses: null },
    ]);
    expect(await count(scope)).toBe(1);
  });

  it("rejects conflicting persisted canonical owners and duplicate exact read IDs", async () => {
    const scope = newUsageScope(), records = await saveUsageInventory(fixture.runtime, scope);
    const target = parseRecordId(records[1].id);
    if (target.source !== "canonical") throw new Error("Expected a canonical fixture.");
    await expect(fixture.runtime.query(`INSERT INTO unified_agent_memberships(generation_id,scope_id,tenant_id,identity,schema_version,
      source_scope_id,source_identity,source_generation_id,evidence)
      SELECT generation_id,scope_id,tenant_id,$2,1,source_scope_id,source_identity,source_generation_id,evidence
      FROM unified_agent_memberships WHERE tenant_id=$1 AND source_identity='Package-A' LIMIT 1`,
    [scope.tenantId, target.agentId])).rejects.toMatchObject({ code: "P0001", message: "data_writer_fenced" });
    await expect(read(scope, [records[0].id, records[0].id])).rejects.toMatchObject({ code: "data_exact_ids_limit" });
  });

  it("deduplicates exact report IDs and case-sensitive positive users across merged memberships", async () => {
    const scope = newUsageScope(), records = await saveUsageInventory(fixture.runtime, scope, [{ packages: ["Report-A", "Report-B"] }]);
    await publishUsageReports(fixture.runtime, scope);
    await mutate(scope, records[0].id, await usageIntent(fixture.runtime, scope, "Report-A", { source: "graph_packages", packageId: "Report-A" }));
    expect((await read(scope, [records[0].id]))[0]).toMatchObject({ responses: 30, activeUsers: 3, associationCount: 2 });
  });

  it("uses Agents response/activity authority rather than Users and bridge response totals", async () => {
    const scope = newUsageScope(), records = await saveUsageInventory(fixture.runtime, scope, [{ packages: ["Report-A", "Report-B"] }]);
    await publishUsageReports(fixture.runtime, scope, 10, (kind, content) => kind === "userAgents"
      ? content.replace("CaseUser,4,2026-09-16", "CaseUser,50000,2030-01-01")
      : kind === "users" ? content.replace("CaseUser,One,1,4", "CaseUser,One,1,70000") : content);
    expect((await read(scope, [records[0].id]))[0]).toMatchObject({ responses: 30, activeUsers: 3, lastActivityDateUtc: "2026-09-18T00:00:00.000Z" });
  });

  it.each(["one", "all"])("keeps missing %s companion evidence unknown rather than substituting license-category counts", async missing => {
    const scope = newUsageScope(), records = await saveUsageInventory(fixture.runtime, scope, [{ packages: ["Report-A", "Report-B"] }]);
    await publishUsageReports(fixture.runtime, scope, 10, (kind, content) => kind !== "userAgents" ? content
      : content.split("\n").filter((row, index) => index === 0 || missing !== "all" && !row.startsWith("Report-B,")).join("\n"));
    expect((await read(scope, [records[0].id]))[0]).toMatchObject({ status: "linked", responses: 30, activeUsers: null });
  });

  it("preserves explicit zero and ignores bridge-only identities", async () => {
    const scope = newUsageScope(), records = await saveUsageInventory(fixture.runtime, scope, [{ packages: ["Report-Zero", "Bridge-Only"] }]);
    await publishUsageReports(fixture.runtime, scope);
    expect((await read(scope, [records[0].id]))[0]).toMatchObject({ status: "linked", responses: 0, activeUsers: 0, lastActivityDateUtc: null, associationCount: 1 });
  });

  it.each(["package-case", "source", "snapshot", "expired"] as const)("does not resolve a reviewed %s mismatch", async mismatch => {
    const scope = newUsageScope(), records = await saveUsageInventory(fixture.runtime, scope);
    await publishUsageReports(fixture.runtime, scope);
    await mutate(scope, records[0].id, await usageIntent(fixture.runtime, scope));
    const viewer = { ...scope, principalId: `viewer-${mismatch}` };
    const viewed = await saveUsageInventory(fixture.runtime, viewer, [mismatch === "source"
      ? { packages: [], native: { nativeId: "Package-A", environmentId: null } } : { packages: [mismatch === "package-case" ? "package-a" : "Package-A"] }],
    mismatch === "expired" ? { expiresAt: new Date(Date.now() + 3000) } : {});
    if (mismatch === "snapshot") await fixture.operator.query(`UPDATE data_scope_epochs SET epoch=epoch+1
      WHERE tenant_id=$1 AND principal_id=$2 AND source='inventory_packages'`, [scope.tenantId, viewer.principalId]);
    if (mismatch === "expired") await awaitUsageInventoryExpiry(fixture.runtime, viewer);
    expect((await inventory(viewer, viewed.map(record => record.id)))[0]).toMatchObject({ status: "unlinked", responses: null });
  });

  it("retains stale activity-range provenance and unknown freshness without treating imports as source metadata", async () => {
    const scope = newUsageScope(), records = await saveUsageInventory(fixture.runtime, scope, [{ packages: ["Report-A"] }]);
    const date = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
    await publishUsageReports(fixture.runtime, scope, 10, (_kind, content) => content.replace(/2026-09-\d{2}/g, date));
    const [summary] = await read(scope, [records[0].id]);
    expect(summary.context.reports).toMatchObject({ availability: "stale", reportingPeriod: { provenance: "activity_range" } });
    expect(summary.context.reports.lineages).toHaveLength(3);
    expect(summary.context.reports.lineages.every(row => row.sourceFreshness === "unknown" && row.sourceAsOfProvenance === "absent")).toBe(true);
  });

  it("rejects inexact totals rather than silently rounding a merged logical agent", async () => {
    const scope = newUsageScope(), records = await saveUsageInventory(fixture.runtime, scope, [{ packages: ["Report-A", "Report-B"] }]);
    await expect((async () => {
      await publishUsageReports(fixture.runtime, scope, Number.MAX_SAFE_INTEGER);
      await read(scope, records.map(record => record.id));
    })()).rejects.toMatchObject({ code: "numeric_overflow" });
  });

  it("fences association ABA cycles and keeps deterministic ordered inventory revision composition", async () => {
    const scope = newUsageScope(), records = await saveUsageInventory(fixture.runtime, scope);
    await publishUsageReports(fixture.runtime, scope);
    const before = await usageIntent(fixture.runtime, scope);
    await mutate(scope, records[0].id, before);
    const after = await usageIntent(fixture.runtime, scope), { target: _target, ...remove } = after;
    await mutate(scope, records[0].id, remove);
    const restored = await usageIntent(fixture.runtime, scope);
    expect(restored.usageRevision).not.toBe(before.usageRevision);
    expect(restored.usageRevision).not.toBe(after.usageRevision);
    expect(restored.inventoryRevision).toBe(before.inventoryRevision);
  });

  it("does not turn read database failures into an empty successful summary", async () => {
    const scope = newUsageScope(), records = await saveUsageInventory(fixture.runtime, scope), identity = await usageIdentity(fixture.runtime, scope);
    const selection = await reports.capture(identity, "delegated", "official_agents"), error = new Error("Database unavailable");
    vi.spyOn(reports.history.connections, "selectedRead").mockRejectedValue(error);
    await expect(usage.summaries(selection.id, identity, [records[0].id])).rejects.toBe(error);
  });

  it("revalidates selection expiry after rows are read without replaying the read callback", async () => {
    const scope = newUsageScope(), records = await saveUsageInventory(fixture.runtime, scope);
    const accepted = await publishUsageReports(fixture.runtime, scope);
    await fixture.operator.query("UPDATE official_usage_sets SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1", [accepted.setId]);
    const identity = await usageIdentity(fixture.runtime, scope), selection = await reports.capture(identity, "delegated", "official_agents");
    const callback = vi.fn(async (client: import("pg").PoolClient) => {
      await client.query("SELECT pg_sleep(1.05)");
      return records[0].id;
    });
    await expect(reports.read(selection.id, identity, callback)).rejects.toMatchObject({ code: "selection_invalidated" });
    expect(callback).toHaveBeenCalledOnce();
  });
});

describe("native reviewed mutation publication", () => {
  it.each(["attach", "remove"] as const)("commits %s with the same valid report and its durable success receipt", async action => {
    const scope = newUsageScope(), records = await saveUsageInventory(fixture.runtime, scope);
    await publishUsageReports(fixture.runtime, scope);
    if (action === "remove") await mutate(scope, records[0].id, await usageIntent(fixture.runtime, scope));
    const input = await usageIntent(fixture.runtime, scope), { target: _target, ...removal } = input;
    const result = await mutate(scope, records[0].id, action === "remove" ? removal : input);
    expect(result.reportSetId).toBe(input.reportSetId);
    expect(result.usageRevision).not.toBe(input.usageRevision);
    expect(await count(scope)).toBe(action === "attach" ? 1 : 0);
    expect((await new AuditLog(scope, fixture.runtime).listEvents({
      action: action === "attach" ? "associate-agent-usage" : "remove-agent-usage-association",
    })).map(row => row.status)).toEqual(["succeeded"]);
  });

  it.each([["attach", "before"], ["remove", "before"], ["attach", "after"], ["remove", "after"]] as const)(
    "rolls back %s when its report expires %s success-audit persistence", async (action, moment) => {
      const scope = newUsageScope(), records = await saveUsageInventory(fixture.runtime, scope);
      await publishUsageReports(fixture.runtime, scope);
      if (action === "remove") await mutate(scope, records[0].id, await usageIntent(fixture.runtime, scope));
      const input = await usageIntent(fixture.runtime, scope), { target: _target, ...removal } = input, complete = AuditLog.prototype.completeEvent;
      const expire = () => fixture.operator.query("UPDATE official_usage_artifacts SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND kind='agents'", [scope.tenantId]);
      vi.spyOn(AuditLog.prototype, "completeEvent").mockImplementation(async function (id, update) {
        if (update.status === "succeeded" && moment === "before") await expire();
        const result = await complete.call(this, id, update);
        if (update.status === "succeeded" && moment === "after") await expire();
        return result;
      });
      await expect(mutate(scope, records[0].id, action === "remove" ? removal : input)).rejects.toMatchObject({ code: "selection_invalidated" });
      expect(await count(scope)).toBe(action === "attach" ? 0 : 1);
      expect((await new AuditLog(scope, fixture.runtime).listEvents({
        action: action === "attach" ? "associate-agent-usage" : "remove-agent-usage-association",
      })).map(row => row.status)).toEqual(["failed"]);
    });

  it("keeps maintenance admission and actor ownership checks ahead of any audit or mutation", async () => {
    const scope = newUsageScope(), records = await saveUsageInventory(fixture.runtime, scope);
    await publishUsageReports(fixture.runtime, scope);
    const input = await usageIntent(fixture.runtime, scope), identity = await usageIdentity(fixture.runtime, scope);
    await expect(usage.mutate(identity, records[0].id, input, usageAudit({ ...scope, principalId: "other" }).actor)).rejects.toMatchObject({ status: 401 });
    const error = new Error("Maintenance fixture");
    vi.spyOn(maintenance, "requireAdmissions").mockImplementation(() => { throw error; });
    await expect(mutate(scope, records[0].id, input)).rejects.toBe(error);
    expect(await new AuditLog(scope, fixture.runtime).listEvents()).toEqual([]);
  });
});

describe("strict native association contracts", () => {
  const input = (): CandidateAgentUsageMutation => ({ selectionId: randomUUID(), reportSetId: randomUUID(),
    usageRevision: "a".repeat(64), inventoryRevision: "b".repeat(64), reportAgentId: "Report-A",
    target: { source: "graph_packages", packageId: "Package-A" }, confirmed: true });

  it("accepts only exact source-qualified targets and explicit confirmation", () => {
    const value = input();
    expect(officialAgentUsageMutation(value)).toEqual(value);
    expect(officialAgentUsageMutation({ ...value, target: { source: "power_platform", nativeId: "Opaque-ID", environmentId: null } }).target)
      .toEqual({ source: "power_platform", nativeId: "Opaque-ID", environmentId: null });
    const { target: _target, ...remove } = value;
    expect(officialAgentUsageMutation(remove)).toEqual(remove);
    expect(reportQuery("official_agents", { search: " Agent " }).search).toBe("agent");
  });

  it.each(["Agent-\u{1f916}", "Agent-\ufffd", "Élan-代理"])("preserves well-formed exact Unicode identifiers %j", text => {
    for (const target of [{ source: "graph_packages" as const, packageId: text },
      { source: "power_platform" as const, nativeId: text, environmentId: text }]) {
      const value = { ...input(), reportAgentId: text, target };
      expect(officialAgentUsageMutation(value)).toEqual(value);
      expect(parseRecordId(unifiedAgentRecordId(target))).toEqual(target);
    }
    expect(reportQuery("official_agents", { search: text }).search).toBe(text.normalize("NFKC").toLowerCase());
  });

  it.each(["\ud800", "\udfff", "\udfff\ud800", "\u0080", "\u0085", "\u009f"])("rejects malformed Unicode and controls %j", character => {
    const text = `Agent-${character}-ID`;
    for (const changes of [{ reportAgentId: text }, { target: { source: "graph_packages", packageId: text } },
      { target: { source: "power_platform", nativeId: text, environmentId: null } },
      { target: { source: "power_platform", nativeId: "Bot-A", environmentId: text } }]) {
      expect(() => officialAgentUsageMutation({ ...input(), ...changes })).toThrow();
    }
    expect(() => reportQuery("official_agents", { search: text })).toThrow();
    expect(() => parseRecordId(`graph:${text}`)).toThrow();
  });

  it.each([null, [], {}, { confirmed: false }, { confirmed: "true" }, { confirmed: 1 }, { confirmed: undefined },
    { selectionId: "not-a-uuid" }, { reportSetId: "not-a-uuid" }, { reportAgentId: "" }, { reportAgentId: "a\nb" }, { reportAgentId: "a".repeat(513) },
    { inventoryRevision: "old" }, { usageRevision: "g".repeat(64) }, { unexpected: true }, { reports: {} }, { target: null },
    { target: { source: "canonical", agentId: randomUUID() } }, { target: { source: "graph_packages", packageId: "Package-A", appId: "forged" } },
    { target: { source: "graph_packages", packageId: "" } }, { target: { source: "graph_packages", packageId: " leading-space" } },
    { target: { source: "power_platform", nativeId: "bot" } }, { target: { source: "power_platform", nativeId: "bot", environmentId: "" } },
    { target: { source: "power_platform", nativeId: "bot", environmentId: null, packageId: "smuggled" } },
  ])("rejects malformed or extended inputs %j", value => {
    const candidate = value === null || Array.isArray(value) || !Object.keys(value).length ? value : { ...input(), ...value };
    expect(() => officialAgentUsageMutation(candidate)).toThrow();
  });

  it.each([["offset", 0], ["offset", 100000], ["limit", 250], ["expectedUsageRevision", "a".repeat(64)],
    ["search", ["one", "two"]], ["search", 1], ["search", "a".repeat(257)], ["search", "a\nb"]])(
    "rejects removed or invalid candidate query %s=%j", (key, value) => {
      expect(() => reportQuery("official_agents", { [key]: value })).toThrow();
    });
});
