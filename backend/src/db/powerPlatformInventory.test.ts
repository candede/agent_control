import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { retain } from "../../scripts/database.js";
import { testDatabase } from "../../scripts/testDatabase.js";
import { powerPlatformResourceTypes, type PowerPlatformResource, type PowerPlatformResourceType } from "../types/powerPlatformInventory.js";
import { inventoryQueryTypes } from "../services/inventoryRoleScope.js";
import { PowerPlatformResourceQueryClient } from "../services/powerPlatformResourceQuery.js";
import { buildCoverage, PowerPlatformInventoryRepository } from "./powerPlatformInventory.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let repository: PowerPlatformInventoryRepository;
const scope = { tenantId: "tenant-a", principalId: "principal-a" };

function queryScope(queriedTypes: readonly PowerPlatformResourceType[] = powerPlatformResourceTypes, environmentScope: string | null = null) {
  return { queriedTypes: [...queriedTypes], environmentScope };
}

beforeAll(async () => { fixture = await testDatabase(); repository = new PowerPlatformInventoryRepository(fixture.runtime); });
afterAll(async () => { await fixture?.close(); });

function resource(nativeId: string, overrides: Partial<PowerPlatformResource> = {}): PowerPlatformResource {
  return {
    tenantId: scope.tenantId,
    nativeId,
    type: "microsoft.copilotstudio/agents",
    location: "unitedstates",
    displayName: nativeId,
    environmentId: "environment-a",
    createdAt: "2026-09-08T10:00:00.000Z",
    createdBy: null,
    lastPublishedAt: null,
    sourceSystem: "power_platform",
    authoringTool: "Copilot Studio",
    creatorType: "unknown",
    agentKind: "copilot_studio_agent",
    lifecycle: "draft",
    identityConfidence: "exact_native",
    identifiers: [{ kind: "power_platform_resource_id", value: nativeId }, { kind: "cds_bot_id", value: `bot-${nativeId}` }],
    provenance: { sourceSystem: { sourceSystem: "power_platform", path: "PowerPlatformResources", maturity: "ga" } },
    details: {},
    unknownFieldCount: 0,
    ...overrides,
  };
}

async function submitAndRun(idempotencyKey: string, roleScope: "full" | "ai" | "unknown" = "full", requestedTypes = powerPlatformResourceTypes) {
  const job = await repository.submit(scope, { idempotencyKey, roleScope, requestedTypes });
  expect(await repository.markRunning(scope, job.id)).toBe(true);
  return job.id;
}

describe.sequential("Power Platform inventory repository", () => {
  it("retains internal sync cleanup provenance instead of blaming the requesting principal", async () => {
    const job = await repository.submit(scope, {
      idempotencyKey: "inventory-sync-cleanup", roleScope: "full", requestedTypes: ["microsoft.copilotstudio/agents"],
    });
    await repository.cancel(scope, job.id, "sync_cleanup");
    await repository.cancel(scope, job.id);
    expect(await repository.getJob(scope, job.id)).toMatchObject({
      status: "cancelled", errorCode: "data_sync_cleanup", message: expect.stringContaining("original failure or interruption"),
    });
  });

  it("projects recognized authoring metadata from an existing saved row without changing its raw evidence", async () => {
    const legacyFixture = await testDatabase();
    const legacyRepository = new PowerPlatformInventoryRepository(legacyFixture.runtime);
    try {
      const owner = { tenantId: "legacy-authoring", principalId: "reader" };
      const job = await legacyRepository.submit(owner, {
        idempotencyKey: "legacy-lite", roleScope: "full", requestedTypes: ["microsoft.copilotstudio/agents"],
      });
      await legacyRepository.markRunning(owner, job.id);
      const saved = await legacyRepository.publish(owner, job.id, {
        ...queryScope(["microsoft.copilotstudio/agents"]), totalRecords: 1, pages: 1, unknownFieldCount: 0,
        resources: [resource("legacy-lite", {
          tenantId: owner.tenantId, authoringTool: null, details: { createdIn: "Copilot Studio Lite" },
          provenance: { authoringTool: { sourceSystem: "power_platform", path: "not_supplied", maturity: "ga" } },
        })],
      });
      const page = await legacyRepository.list(owner);
      expect(page.value[0]).toMatchObject({
        authoringTool: "Microsoft 365 Copilot Agent Builder", details: { createdIn: "Copilot Studio Lite" },
        provenance: { authoringTool: { path: "properties.createdIn" } },
      });
      expect((await legacyRepository.readUnifiedSource(owner)).resources[0].authoringTool).toBe("Microsoft 365 Copilot Agent Builder");
      expect((await legacyFixture.runtime.query("SELECT authoring_tool,details->>'createdIn' AS raw FROM power_platform_inventory_resources WHERE snapshot_id=$1", [saved.snapshotId])).rows)
        .toEqual([{ authoring_tool: null, raw: "Copilot Studio Lite" }]);
    } finally {
      await legacyFixture.close();
    }
  });

  it("joins saved environment names across current snapshots without crossing owner or expiry boundaries", async () => {
    const environmentFixture = await testDatabase();
    const environmentRepository = new PowerPlatformInventoryRepository(environmentFixture.runtime);
    try {
      const owner = { tenantId: "environment-picker-tenant", principalId: "reader" };
      const publish = async (principalId: string, key: string, values: PowerPlatformResource[]) => {
        const partition = { ...owner, principalId };
        const job = await environmentRepository.submit(partition, {
          idempotencyKey: key, roleScope: "full", requestedTypes: [...new Set(values.map(value => value.type))],
        });
        expect(await environmentRepository.markRunning(partition, job.id)).toBe(true);
        return environmentRepository.publish(partition, job.id, { ...queryScope(job.requestedTypes), resources: values, totalRecords: values.length, pages: 1, unknownFieldCount: 0 });
      };
      const environment = resource("environment-a", {
        tenantId: owner.tenantId, type: "microsoft.powerplatform/environments", environmentId: null, displayName: "Finance production",
      });
      const saved = await publish(owner.principalId, "picker-environments", [environment]);
      await publish(owner.principalId, "picker-agents", [resource("agent-a", { tenantId: owner.tenantId })]);
      await publish("another-reader", "picker-other-owner", [{ ...environment, displayName: "Another owner's environment" }]);
      expect((await environmentRepository.readUnifiedSource(owner)).environmentNames).toEqual({ "environment-a": "Finance production" });
      expect((await environmentRepository.readUnifiedSource({ ...owner, tenantId: "another-tenant" })).environmentNames).toEqual({});
      await environmentFixture.operator.query("UPDATE power_platform_inventory_snapshots SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [saved.snapshotId]);
      const expired = await environmentRepository.readUnifiedSource(owner);
      expect(expired.resources).toHaveLength(1);
      expect(expired.environmentNames).toEqual({});
    } finally {
      await environmentFixture.close();
    }
  });

  it("cancels only the owning principal's unfinished read job", async () => {
    const job = await repository.submit(scope, { idempotencyKey: "inventory-cancel", roleScope: "full", requestedTypes: ["microsoft.copilotstudio/agents"] });
    expect(await repository.cancel({ ...scope, principalId: "principal-b" }, job.id)).toBeUndefined();
    expect(await repository.cancel(scope, job.id)).toMatchObject({ status: "cancelled", errorCode: "cancelled" });
  });

  it("publishes complete snapshots atomically and filters private scope before counts and paging", async () => {
    const id = await submitAndRun("broad-a");
    await repository.publish(scope, id, { ...queryScope(), resources: [resource("agent-b"), resource("agent-a")], totalRecords: 2, pages: 2, unknownFieldCount: 1 });
    const page = await repository.list(scope, { search: "agent", sortBy: "displayName", limit: 1 });
    expect(page).toMatchObject({ count: 2, value: [{ nativeId: "agent-a" }], snapshot: { observedCount: 2, pageCount: 2 } });
    expect(page.typeCounts.find(value => value.type === "microsoft.copilotstudio/agents")).toMatchObject({ status: "covered", count: 2 });
    const withoutAgents = await repository.list(scope, { excludeAgents: true, limit: 1 });
    expect(withoutAgents).toMatchObject({ count: 0, value: [] });
    expect(withoutAgents.typeCounts.some(value => value.type === "microsoft.copilotstudio/agents")).toBe(false);
    expect(await repository.list({ ...scope, principalId: "principal-b" })).toMatchObject({ count: 0, value: [], snapshot: null });
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM source_identifiers WHERE source='power_platform'")).rows[0].count).toBe(4);
  });

  it("keeps a broad snapshot current when a narrower scan publishes", async () => {
    const id = await submitAndRun("narrow-a", "full", ["microsoft.copilotstudio/agents"]);
    await repository.publish(scope, id, { ...queryScope(["microsoft.copilotstudio/agents"]), resources: [resource("agent-c")], totalRecords: 1, pages: 1, unknownFieldCount: 0 });
    expect((await repository.list(scope)).value.map(value => value.nativeId)).toEqual(["agent-a", "agent-b"]);
    const narrowSnapshot = (await repository.getJob(scope, id))!.snapshotId!;
    expect((await repository.list(scope, { snapshotId: narrowSnapshot })).value.map(value => value.nativeId)).toEqual(["agent-c"]);
    expect((await repository.listSnapshots(scope)).value.map(value => value.id)).toContain(narrowSnapshot);
    expect((await repository.listJobs(scope)).value[0].id).toBe(id);
    expect((await repository.listJobs({ ...scope, principalId: "principal-b" })).value).toEqual([]);
  });

  it("rejects stale and expired publication while preserving the prior current snapshot", async () => {
    const stale = await submitAndRun("stale-a", "full", ["microsoft.copilotstudio/agents"]);
    const newer = await submitAndRun("stale-b", "full", ["microsoft.copilotstudio/agents"]);
    await expect(repository.publish(scope, stale, { ...queryScope(["microsoft.copilotstudio/agents"]), resources: [resource("stale")], totalRecords: 1, pages: 1, unknownFieldCount: 0 })).rejects.toMatchObject({ code: "inventory_job_superseded" });
    await repository.publish(scope, newer, { ...queryScope(["microsoft.copilotstudio/agents"]), resources: [resource("newer")], totalRecords: 1, pages: 1, unknownFieldCount: 0 });
    const snapshotId = (await repository.getJob(scope, newer))!.snapshotId!;

    const expired = await submitAndRun("expired-publication", "full", ["microsoft.copilotstudio/agents"]);
    await fixture.operator.query("UPDATE power_platform_refresh_jobs SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expired]);
    await expect(repository.publish(scope, expired, { ...queryScope(["microsoft.copilotstudio/agents"]), resources: [resource("expired")], totalRecords: 1, pages: 1, unknownFieldCount: 0 })).rejects.toMatchObject({ code: "inventory_job_state" });
    expect((await repository.list(scope, { snapshotId })).value.map(value => value.nativeId)).toEqual(["newer"]);
  });

  it("orders duplicate display/native values by the full ordinal scoped tuple across pages", async () => {
    const id = await submitAndRun("deterministic-pages", "full", ["microsoft.copilotstudio/agents", "microsoft.powerautomate/agentflows"]);
    await repository.publish(scope, id, {
      ...queryScope(["microsoft.copilotstudio/agents", "microsoft.powerautomate/agentflows"]),
      resources: [
        resource("same", { displayName: "Tie", environmentId: "environment-b" }),
        resource("same", { displayName: "Tie", environmentId: "environment-a" }),
        resource("same", { displayName: "Tie", environmentId: "environment-a", type: "microsoft.powerautomate/agentflows", agentKind: "agent_flow" }),
      ], totalRecords: 3, pages: 1, unknownFieldCount: 0,
    });
    const snapshotId = (await repository.getJob(scope, id))!.snapshotId!;
    const pages = await Promise.all([0, 1, 2].map(offset => repository.list(scope, { snapshotId, sortBy: "displayName", limit: 1, offset })));
    expect(pages.map(page => `${page.value[0].type}:${page.value[0].environmentId}:${page.value[0].nativeId}`)).toEqual([
      "microsoft.copilotstudio/agents:environment-a:same",
      "microsoft.copilotstudio/agents:environment-b:same",
      "microsoft.powerautomate/agentflows:environment-a:same",
    ]);
    const withoutAgents = await repository.list(scope, { snapshotId, excludeAgents: true, limit: 1 });
    expect(withoutAgents).toMatchObject({
      count: 1,
      value: [{ type: "microsoft.powerautomate/agentflows" }],
    });
    expect(withoutAgents.typeCounts.some(value => value.type === "microsoft.copilotstudio/agents")).toBe(false);
    expect(withoutAgents.typeCounts.find(value => value.type === "microsoft.powerautomate/agentflows")).toMatchObject({
      count: 1,
    });
  });

  it("uses the newest tenant-wide agent snapshot without displacing broad non-agent coverage or crossing environment scopes", async () => {
    const unifiedScope = { tenantId: "tenant-pp-unified", principalId: "principal-pp-unified" };
    const unifiedRepository = new PowerPlatformInventoryRepository(fixture.runtime);
    const global = await unifiedRepository.submit(unifiedScope, {
      idempotencyKey: "unified-global",
      roleScope: "full",
      requestedTypes: powerPlatformResourceTypes,
    });
    expect(await unifiedRepository.markRunning(unifiedScope, global.id)).toBe(true);
    await unifiedRepository.publish(unifiedScope, global.id, {
      ...queryScope(),
      resources: [
        resource("global-agent", { tenantId: unifiedScope.tenantId }),
        resource("excluded-flow", {
          tenantId: unifiedScope.tenantId,
          type: "microsoft.powerautomate/agentflows",
          agentKind: "agent_flow",
        }),
      ],
      totalRecords: 2,
      pages: 1,
      unknownFieldCount: 0,
    });
    const agentsOnly = await unifiedRepository.submit(unifiedScope, {
      idempotencyKey: "unified-agents-only",
      roleScope: "full",
      requestedTypes: ["microsoft.copilotstudio/agents"],
    });
    expect(await unifiedRepository.markRunning(unifiedScope, agentsOnly.id)).toBe(true);
    await unifiedRepository.publish(unifiedScope, agentsOnly.id, {
      ...queryScope(["microsoft.copilotstudio/agents"]),
      resources: [resource("newer-global-agent", { tenantId: unifiedScope.tenantId })],
      totalRecords: 1,
      pages: 1,
      unknownFieldCount: 0,
    });
    const scoped = await unifiedRepository.submit(unifiedScope, {
      idempotencyKey: "unified-scoped",
      roleScope: "full",
      environmentScope: "environment-a",
      requestedTypes: ["microsoft.copilotstudio/agents"],
    });
    expect(await unifiedRepository.markRunning(unifiedScope, scoped.id)).toBe(true);
    await unifiedRepository.publish(unifiedScope, scoped.id, {
      ...queryScope(["microsoft.copilotstudio/agents"], "environment-a"),
      resources: [resource("scoped-newer", { tenantId: unifiedScope.tenantId })],
      totalRecords: 1,
      pages: 1,
      unknownFieldCount: 0,
    });

    const source = await unifiedRepository.readUnifiedSource(unifiedScope);
    expect(source.resources.map(value => value.nativeId)).toEqual(["newer-global-agent"]);
    expect(source.snapshot).toMatchObject({
      environmentScope: null,
      requestedTypes: ["microsoft.copilotstudio/agents"],
    });

    const nonAgentInventory = await unifiedRepository.list(unifiedScope, { excludeAgents: true, limit: 10 });
    expect(nonAgentInventory.value.map(value => value.nativeId)).toEqual(["excluded-flow"]);
    expect(nonAgentInventory.snapshot).toMatchObject({
      environmentScope: null,
      requestedTypes: expect.arrayContaining(powerPlatformResourceTypes),
    });
  });

  it("keeps old rows visible until atomic commit and restores them after a mid-publication rollback", async () => {
    const initial = await submitAndRun("atomic-initial", "full", ["microsoft.copilotstudio/agents"]);
    await repository.publish(scope, initial, { ...queryScope(["microsoft.copilotstudio/agents"]), resources: [resource("old-visible")], totalRecords: 1, pages: 1, unknownFieldCount: 0 });
    const initialSnapshotId = (await repository.getJob(scope, initial))!.snapshotId!;
    await fixture.operator.query(`CREATE FUNCTION hold_inventory_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(404365); RETURN NEW; END $$;
      CREATE TRIGGER hold_inventory_snapshot AFTER INSERT ON power_platform_inventory_snapshots FOR EACH ROW EXECUTE FUNCTION hold_inventory_snapshot()`);
    const lock = await fixture.operator.connect();
    await lock.query("SELECT pg_advisory_lock(404365)");
    try {
      const next = await submitAndRun("atomic-next", "full", ["microsoft.copilotstudio/agents"]);
      const publishing = repository.publish(scope, next, { ...queryScope(["microsoft.copilotstudio/agents"]), resources: [resource("new-visible")], totalRecords: 1, pages: 1, unknownFieldCount: 0 });
      await vi.waitFor(async () => expect((await fixture.operator.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'")).rows[0].count).toBeGreaterThan(0));
      expect((await repository.list(scope, { snapshotId: initialSnapshotId })).value.map(value => value.nativeId)).toEqual(["old-visible"]);
      await lock.query("SELECT pg_advisory_unlock(404365)");
      await publishing;
      const nextSnapshotId = (await repository.getJob(scope, next))!.snapshotId!;
      expect((await repository.list(scope, { snapshotId: nextSnapshotId })).value.map(value => value.nativeId)).toEqual(["new-visible"]);
    } finally {
      await lock.query("SELECT pg_advisory_unlock_all()");
      lock.release();
      await fixture.operator.query("DROP TRIGGER hold_inventory_snapshot ON power_platform_inventory_snapshots; DROP FUNCTION hold_inventory_snapshot() CASCADE");
    }

    await fixture.operator.query(`CREATE FUNCTION reject_inventory_resource() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.native_id='rollback-new' THEN RAISE EXCEPTION 'fixture rollback'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_inventory_resource BEFORE INSERT ON power_platform_inventory_resources FOR EACH ROW EXECUTE FUNCTION reject_inventory_resource()`);
    try {
      const rollback = await submitAndRun("atomic-rollback", "full", ["microsoft.copilotstudio/agents"]);
      await expect(repository.publish(scope, rollback, { ...queryScope(["microsoft.copilotstudio/agents"]), resources: [resource("rollback-new")], totalRecords: 1, pages: 1, unknownFieldCount: 0 })).rejects.toThrow("fixture rollback");
      const currentSnapshotId = (await repository.listSnapshots(scope)).value.find(snapshot => snapshot.requestedTypes.length === 1)!.id;
      expect((await repository.list(scope, { snapshotId: currentSnapshotId })).value.map(value => value.nativeId)).toEqual(["new-visible"]);
    } finally {
      await fixture.operator.query("DROP TRIGGER reject_inventory_resource ON power_platform_inventory_resources; DROP FUNCTION reject_inventory_resource() CASCADE");
    }
  });

  it("preserves prior rows after failed progress and incomplete unknown-role enumeration", async () => {
    const failedId = await submitAndRun("failed-a");
    await repository.recordProgress(scope, failedId, 1, 1, 2);
    await repository.markFailed(scope, failedId, "provider_error", "The provider query failed.");
    expect(await repository.getJob(scope, failedId)).toMatchObject({ status: "failed", pageCount: 1, observedCount: 1, totalRecords: 2 });
    expect((await repository.list(scope)).count).toBe(2);

    const firstUnknown = await submitAndRun("unknown-a", "unknown");
    await repository.publish(scope, firstUnknown, { ...queryScope(), resources: [resource("unknown-a"), resource("unknown-b")], totalRecords: 2, pages: 1, unknownFieldCount: 0 });
    const secondUnknown = await submitAndRun("unknown-b", "unknown");
    await expect(repository.publish(scope, secondUnknown, { ...queryScope(), resources: [resource("unknown-a")], totalRecords: 2, pages: 1, unknownFieldCount: 0 })).rejects.toMatchObject({ code: "incomplete_inventory_coverage" });
    const unknownSnapshot = (await repository.getJob(scope, firstUnknown))!.snapshotId!;
    expect((await repository.list(scope, { snapshotId: unknownSnapshot })).count).toBe(2);
  });

  it.each([
    { name: "fewer resources", names: ["retained"] },
    { name: "different resources at the same count", names: ["replacement-a", "replacement-b"] },
    { name: "no visible resources", names: [] },
  ])("verifies a complete authorized query with $name independently of optional role claims", async ({ name, names }) => {
    const owner = { ...scope, principalId: `unknown-reader-${name}` };
    async function publish(key: string, nativeIds: string[]) {
      const job = await repository.submit(owner, { idempotencyKey: key, roleScope: "unknown", requestedTypes: powerPlatformResourceTypes });
      await repository.markRunning(owner, job.id);
      return repository.publish(owner, job.id, {
        ...queryScope(),
        resources: nativeIds.map(nativeId => resource(nativeId)), totalRecords: nativeIds.length, pages: 1, unknownFieldCount: 0,
      });
    }
    const previous = await publish("previous", ["retained", "removed"]);
    const current = await publish("current", names);
    expect(current.job).toMatchObject({ status: "succeeded", observedCount: names.length });
    const saved = await repository.list(owner);
    expect(saved.snapshot).toMatchObject({
      id: current.snapshotId, roleScope: "unknown",
      verification: { status: "verified", scope: "authorized_query", storedCount: names.length, uniqueIdentityCount: names.length, queriedTypes: powerPlatformResourceTypes },
    });
    expect(saved.value.map(row => row.nativeId)).toEqual(names);
    expect(saved.typeCounts.every(coverage => coverage.status === "covered")).toBe(true);
    expect(saved.typeCounts.find(coverage => coverage.type === "microsoft.copilotstudio/agents")?.count).toBe(names.length);
    expect((await repository.listSnapshots(owner)).value.map(snapshot => snapshot.id)).toEqual([current.snapshotId]);
    expect((await fixture.runtime.query("SELECT is_current FROM power_platform_inventory_snapshots WHERE id=$1", [previous.snapshotId])).rows)
      .toEqual([{ is_current: false }]);
  });

  it("rolls back tenant-mismatched publication and requires explicit authorization resume", async () => {
    const id = await repository.submit(scope, { idempotencyKey: "reauth-a", roleScope: "full", requestedTypes: powerPlatformResourceTypes });
    expect(id.status).toBe("waiting_authorization");
    expect(await repository.markRunning(scope, id.id)).toBe(true);
    await expect(repository.publish(scope, id.id, { ...queryScope(), resources: [resource("wrong", { tenantId: "tenant-b" })], totalRecords: 1, pages: 1, unknownFieldCount: 0 })).rejects.toMatchObject({ code: "scope_mismatch" });
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM power_platform_inventory_snapshots WHERE job_id=$1", [id.id])).rows[0].count).toBe(0);
    await repository.markWaitingAuthorization(scope, id.id);
    expect(await repository.getJob(scope, id.id)).toMatchObject({ status: "waiting_authorization", errorCode: "interaction_required" });
  });

  it("applies finite snapshot and job retention without runtime deletion authority", async () => {
    await fixture.operator.query("UPDATE power_platform_inventory_snapshots SET expires_at=clock_timestamp()-interval '1 second'");
    await fixture.operator.query("UPDATE power_platform_refresh_jobs SET expires_at=clock_timestamp()-interval '1 second' WHERE status='failed'");
    await retain(fixture.operator);
    expect((await repository.list(scope)).snapshot).toBeNull();
    await expect(fixture.runtime.query("DELETE FROM power_platform_inventory_snapshots")).rejects.toThrow();
  });

  it("separates role-filtered and unrequested types from verified empty query results", () => {
    const aiCoverage = buildCoverage(powerPlatformResourceTypes, inventoryQueryTypes("ai", powerPlatformResourceTypes),
      new Map([["microsoft.copilotstudio/agents", 1]]));
    expect(aiCoverage.find(value => value.type === "microsoft.powerapps/canvasapps")).toEqual({ type: "microsoft.powerapps/canvasapps", status: "not_authorized_scope", count: null });
    expect(aiCoverage.find(value => value.type === "microsoft.copilotstudio/agents")).toEqual({ type: "microsoft.copilotstudio/agents", status: "covered", count: 1 });
    const emptyCoverage = buildCoverage(powerPlatformResourceTypes, powerPlatformResourceTypes, new Map());
    expect(emptyCoverage.every(value => value.status === "covered" && value.count === 0)).toBe(true);
    const agentCoverage = buildCoverage(["microsoft.copilotstudio/agents"], ["microsoft.copilotstudio/agents"], new Map());
    expect(agentCoverage.find(value => value.type === "microsoft.powerapps/canvasapps")).toMatchObject({ status: "not_requested", count: null });
  });

  it("resolves identifiers from the entire authorized snapshot before paging without joining other principals", async () => {
    const privateScope = { tenantId: "tenant-a", principalId: "identity-reader" };
    const sharedIdentifier = { kind: "entra_agent_id" as const, value: "exact-fixture-identifier" };
    async function publishFor(principalId: string, names: string[], key: string) {
      const owner = { ...privateScope, principalId };
      const job = await repository.submit(owner, { idempotencyKey: key, roleScope: "full", requestedTypes: powerPlatformResourceTypes });
      await repository.markRunning(owner, job.id);
      await repository.publish(owner, job.id, { ...queryScope(), resources: names.map(name => resource(name, { identifiers: [sharedIdentifier] })), totalRecords: names.length, pages: 1, unknownFieldCount: 0 });
    }
    await publishFor("other-identity-reader", ["private-collision"], "private");
    await publishFor(privateScope.principalId, ["visible-a"], "unmatched");
    expect((await repository.list(privateScope)).value[0].association).toMatchObject({ status: "unresolved" });
    await publishFor(privateScope.principalId, ["visible-b", "visible-a"], "resolved");
    const resolved = await repository.list(privateScope, { search: "visible-a", limit: 1 });
    expect(resolved).toMatchObject({ count: 1, value: [{ association: { status: "resolved", candidate: { nativeId: "visible-b" } } }] });
    expect(JSON.stringify(resolved)).not.toContain("private-collision");
    await publishFor(privateScope.principalId, ["visible-c", "visible-b", "visible-a"], "ambiguous");
    const first = await repository.list(privateScope, { search: "visible-a", limit: 1 });
    const second = await repository.list(privateScope, { search: "visible-a", limit: 1 });
    expect(first.value[0].association).toMatchObject({ status: "ambiguous", candidates: [{ nativeId: "visible-b" }, { nativeId: "visible-c" }] });
    expect(first.value).toEqual(second.value);
    expect(first.typeCounts).toEqual(second.typeCounts);
    expect(first.snapshot?.id).toBe(second.snapshot?.id);
    expect(JSON.stringify(first)).not.toContain("private-collision");
  });

  it("retains source success and saved data after independent seven-day job expiry", async () => {
    const retainedScope = { ...scope, principalId: "retained-source-reader" };
    const job = await repository.submit(retainedScope, { idempotencyKey: "retention", roleScope: "full", requestedTypes: powerPlatformResourceTypes });
    await repository.markRunning(retainedScope, job.id);
    await repository.publish(retainedScope, job.id, { ...queryScope(), resources: [resource("retained-source")], totalRecords: 1, pages: 1, unknownFieldCount: 0 });
    const before = await repository.listJobs(retainedScope);
    await fixture.operator.query("UPDATE power_platform_refresh_jobs SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id]);
    await retain(fixture.operator);
    expect((await fixture.operator.query("SELECT id FROM power_platform_refresh_jobs WHERE id=$1", [job.id])).rowCount).toBe(0);
    const after = await repository.listJobs(retainedScope);
    expect(after).toMatchObject({ value: [], lastAttemptAt: null, lastSuccessAt: before.lastSuccessAt });
    expect(after.lastSuccessAt).not.toBeNull();
    expect((await repository.list(retainedScope)).value[0].nativeId).toBe("retained-source");
    expect((await repository.listJobs({ ...retainedScope, principalId: "not-the-owner" })).lastSuccessAt).toBeNull();
  });

  it("persists connector source metadata separately from the private collection tenant", async () => {
    const catalogScope = { tenantId: "catalog-tenant", principalId: "catalog-reader" };
    const nativeId = "shared-catalog-native-id";
    const query = new PowerPlatformResourceQueryClient(vi.fn().mockResolvedValue(Response.json({
      totalRecords: 1, count: 1, resultTruncated: 0,
      data: [{ tenantId: "", name: nativeId, type: "microsoft.powerplatformconnector/connectors", properties: { displayName: "Catalog connector" } }],
    })));
    const result = await query.query("opaque-token", undefined, { expectedTenantId: catalogScope.tenantId });
    const job = await repository.submit(catalogScope, { idempotencyKey: "catalog-metadata", roleScope: "full", requestedTypes: powerPlatformResourceTypes });
    await repository.markRunning(catalogScope, job.id);
    await repository.publish(catalogScope, job.id, result);

    expect(await repository.getJob(catalogScope, job.id)).toMatchObject({ status: "succeeded", observedCount: 1 });
    const page = await repository.list(catalogScope);
    expect(page.value).toMatchObject([{
      tenantId: catalogScope.tenantId, nativeId, environmentId: null,
      details: { sourceTenantId: "" },
      provenance: { tenantId: { path: "authenticated_query.tenantId" }, sourceTenantId: { path: "tenantId" } },
    }]);
    expect(await repository.list({ ...catalogScope, tenantId: "other-tenant" })).toMatchObject({ count: 0, snapshot: null });
    expect(await repository.list({ ...catalogScope, principalId: "other-reader" })).toMatchObject({ count: 0, snapshot: null });
    expect((await fixture.runtime.query("SELECT tenant_id,native_id FROM source_identifiers WHERE tenant_id=$1", [catalogScope.tenantId])).rows)
      .toEqual([{ tenant_id: catalogScope.tenantId, native_id: nativeId }]);
  });

  it.each(["full", "unknown"] as const)("publishes 4140 then 4173 changed resources over 42 pages for %s roles, preserving the snapshot on a later incomplete refresh", async roleScope => {
    const owner = { tenantId: "terminal-tenant", principalId: `terminal-reader-${roleScope}` };
    const job = await repository.submit(owner, { idempotencyKey: "terminal-page", roleScope, requestedTypes: powerPlatformResourceTypes });
    await repository.markRunning(owner, job.id);
    let totalRecords = 4_140;
    let identityOffset = 0;
    const query = new PowerPlatformResourceQueryClient(vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const { Options: options } = JSON.parse(String(init?.body));
      const offset = Number(options.SkipToken ?? 0);
      const count = Math.min(100, totalRecords - offset);
      return Response.json({
        totalRecords, count, resultTruncated: 1,
        ...(offset + count < totalRecords ? { skipToken: String(offset + count) } : {}),
        data: Array.from({ length: count }, (_, index) => ({
          tenantId: owner.tenantId, name: `agent-${String(identityOffset + offset + index).padStart(4, "0")}`,
          type: "microsoft.copilotstudio/agents", properties: {},
        })),
      });
    }));
    const result = await query.query("opaque-token", undefined, {
      expectedTenantId: owner.tenantId,
      onProgress: progress => repository.recordProgress(owner, job.id, progress.pages, progress.observedCount, progress.totalRecords),
    });
    await repository.publish(owner, job.id, result);
    const complete = await repository.getJob(owner, job.id);
    expect(complete).toMatchObject({ status: "succeeded", observedCount: 4_140, totalRecords: 4_140, pageCount: 42 });
    expect(complete?.snapshotId).toEqual(expect.any(String));
    expect(await repository.list(owner, { offset: 4_100, limit: 50 })).toMatchObject({
      count: 4_140, snapshot: { id: complete?.snapshotId, pageCount: 42, observedCount: 4_140 },
      value: Array.from({ length: 40 }, (_, index) => ({ nativeId: `agent-${4_100 + index}` })),
    });
    expect((await repository.listJobs(owner)).lastSuccessAt).not.toBeNull();

    totalRecords = 4_173;
    identityOffset = 1;
    const next = await repository.submit(owner, { idempotencyKey: "changed-next", roleScope, requestedTypes: powerPlatformResourceTypes });
    await repository.markRunning(owner, next.id);
    const changed = await query.query("opaque-token", undefined, {
      expectedTenantId: owner.tenantId,
      onProgress: progress => repository.recordProgress(owner, next.id, progress.pages, progress.observedCount, progress.totalRecords),
    });
    const published = await repository.publish(owner, next.id, changed);
    expect(published.job).toMatchObject({ status: "succeeded", observedCount: 4_173, totalRecords: 4_173, pageCount: 42 });
    expect(await repository.list(owner, { search: "agent-0000" })).toMatchObject({ count: 0 });
    expect(await repository.list(owner, { offset: 4_100, limit: 100 })).toMatchObject({
      count: 4_173, snapshot: { id: published.snapshotId, roleScope, pageCount: 42, observedCount: 4_173 },
      value: Array.from({ length: 73 }, (_, index) => ({ nativeId: `agent-${4_101 + index}` })),
    });
    const failed = await repository.submit(owner, { idempotencyKey: "incomplete-next", roleScope, requestedTypes: powerPlatformResourceTypes });
    await repository.markRunning(owner, failed.id);
    await expect(repository.publish(owner, failed.id, { ...changed, resources: changed.resources.slice(0, 4_100) })).rejects.toMatchObject({ code: "incomplete_inventory_coverage" });
    expect((await repository.list(owner)).snapshot?.id).toBe(published.snapshotId);
    expect(await repository.list({ ...owner, principalId: "another-reader" })).toMatchObject({ snapshot: null, count: 0 });
  });
});