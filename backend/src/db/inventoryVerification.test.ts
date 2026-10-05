import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { inventoryBaseline, inventoryDelta, inventoryInput, inventorySelectionFixture, nativeInventoryFixture, reconcileInventoryFixture } from "../../scripts/inventoryFixtures.js";
import { inventoryPresentation, inventorySourceStatuses } from "../services/inventoryPresentation.js";
import { PowerPlatformResourceQueryClient } from "../services/powerPlatformResourceQuery.js";
import { StreamedInventory } from "../services/streamedInventory.js";
import { powerPlatformResourceTypes, type InventoryRoleScope, type PowerPlatformResourceType } from "../types/powerPlatformInventory.js";
import { unifiedAgentRecordId } from "../types/unifiedAgents.js";
import { InventoryGenerations, inventorySelector } from "./inventoryGenerations.js";
import { LiveInventory } from "./liveInventory.js";
import { InventoryIdentityQueries, currentNativeInventorySql } from "./inventoryIdentityQueries.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => { fixture = await testDatabase(); });
afterAll(async () => { await fixture?.close(); });
const agentType = "microsoft.copilotstudio/agents";
const environmentId = "11111111-1111-4111-8111-111111111111";
const nativeIds = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"];

async function publishInventory(roleScope: InventoryRoleScope = "unknown", requestedTypes: readonly PowerPlatformResourceType[] = powerPlatformResourceTypes) {
  const scope = { tenantId: `verification-${randomUUID()}`, principalId: "reader" };
  const input = inventoryInput(scope.principalId, "power_platform");
  input.scope.tenantId = scope.tenantId;
  input.scope.selector = inventorySelector({ domain: "power_platform", resourceTypes: requestedTypes });
  const provider = new PowerPlatformResourceQueryClient(async () => Response.json({
    totalRecords: 2, count: 2, resultTruncated: 0,
    data: nativeIds.map(name => ({ name, tenantId: scope.tenantId, type: agentType, properties: { environmentId, displayName: name } })),
  }));
  const publisher = new StreamedInventory(fixture.runtime, undefined, provider);
  const root = await publisher.powerPlatformCatalog(input, "synthetic-token", requestedTypes, { roleScope, authorize: async () => {} });
  return { scope, root, input, publisher };
}

describe("typed immutable inventory verification", () => {
  it.each(["full", "ai", "unknown"] as const)("verifies source counts independently of filtering, paging and the %s role hint", async roleScope => {
    const { scope, root } = await publishInventory(roleScope);
    const selected = await inventorySelectionFixture(fixture.runtime, scope, { search: nativeIds[0] }, "power_platform");
    const page = await selected.queries.page(selected.selection.id, selected.identity, { limit: 1 });
    expect(page.counts).toMatchObject({ total: 2, scoped: 2, filtered: 1 });
    expect(page.value.map(row => row.nativeId)).toEqual([nativeIds[0]]);
    expect(inventorySourceStatuses(page.freshness.sources).powerPlatform).toMatchObject({
      state: "available", observation: { snapshotId: root.baselineId, roleScope, coverage: "covered",
        observedCount: 2, totalRecords: 2, pageCount: 1, coveredCount: 2,
        verification: { status: "verified", scope: "authorized_query", storedCount: 2, uniqueIdentityCount: 2,
          queriedTypes: expect.arrayContaining(powerPlatformResourceTypes) } },
    });
  });

  it("prevents published native row deletion and retains verified selected and current identity reads", async () => {
    const { scope, root } = await publishInventory();
    await reconcileInventoryFixture(fixture.runtime, scope);
    const selected = await inventorySelectionFixture(fixture.runtime, scope, {}, "power_platform");
    await expect(fixture.operator.query("DELETE FROM power_platform_record_rows WHERE generation_id=$1", [root.baselineId]))
      .rejects.toThrow("inventory_content_pinned");
    expect((await selected.queries.page(selected.selection.id, selected.identity)).counts.total).toBe(2);
    for (const nativeId of nativeIds) {
      const record = await new LiveInventory(fixture.runtime).record(scope, unifiedAgentRecordId({ source: "power_platform", nativeId, environmentId }));
      expect(record.native?.resource.nativeId).toBe(nativeId);
    }
  });

  it("uses the latest executed source scope for current identities and never another principal's source", async () => {
    const { scope } = await publishInventory();
    const latest = await nativeInventoryFixture(fixture.runtime, scope, nativeIds.map(nativeId => ({
      nativeId, environmentId, identifiers: [{ kind: "entra_agent_id", value: nativeId }],
    })), { resourceTypes: [agentType] });
    await reconcileInventoryFixture(fixture.runtime, scope);
    for (const nativeId of nativeIds) {
      const id = unifiedAgentRecordId({ source: "power_platform", nativeId, environmentId });
      const record = await new LiveInventory(fixture.runtime).record(scope, id);
      expect(record.native).toMatchObject({ identifiers: [{ kind: "entra_agent_id", value: nativeId }],
        observation: { snapshotId: latest.baselineId } });
      await expect(new LiveInventory(fixture.runtime).record({ ...scope, principalId: "different-reader" }, id))
        .rejects.toMatchObject({ code: "agent_not_found" });
    }
  });

  it("uses the newest complete tenant-wide agent query without unioning obsolete or environment-scoped membership", async () => {
    const scope = { tenantId: "native-source-precedence", principalId: randomUUID() };
    await nativeInventoryFixture(fixture.runtime, scope, [
      { nativeId: "obsolete-global-agent", environmentId, identifiers: [] },
      { nativeId: environmentId, type: "microsoft.powerplatform/environments", displayName: "Finance production", identifiers: [] },
    ], { resourceTypes: [...powerPlatformResourceTypes] });
    const latest = await nativeInventoryFixture(fixture.runtime, scope,
      [{ nativeId: "current-global-agent", environmentId, identifiers: [] }], { resourceTypes: [agentType] });
    await nativeInventoryFixture(fixture.runtime, scope,
      [{ nativeId: "scoped-only-agent", environmentId, identifiers: [] }], { resourceTypes: [agentType], environmentId });
    await reconcileInventoryFixture(fixture.runtime, scope);
    const selected = await inventorySelectionFixture(fixture.runtime, scope);
    const page = inventoryPresentation(selected.raw);
    expect(page.value.map(row => row.powerPlatformResource?.nativeId)).toEqual(["current-global-agent"]);
    expect(page.value[0].environment).toMatchObject({ displayName: "Finance production" });
    expect(inventorySourceStatuses(selected.raw.freshness.sources).powerPlatform)
      .toMatchObject({ observation: { snapshotId: latest.baselineId, environmentScope: null, observedCount: 1 } });
    await expect(new LiveInventory(fixture.runtime).record(scope,
      unifiedAgentRecordId({ source: "power_platform", nativeId: "obsolete-global-agent", environmentId })))
      .rejects.toMatchObject({ code: "agent_not_found" });
  });

  it("pins source-scope precedence and retains canonical survivors across changed complete queries and verified emptiness", async () => {
    const scope = { tenantId: "native-scope-survivors", principalId: randomUUID() };
    const environment = (displayName: string) => ({
      nativeId: environmentId, type: "microsoft.powerplatform/environments" as const, displayName, identifiers: [],
    });
    const agent = (nativeId: string) => ({ nativeId, environmentId, identifiers: [] });
    await nativeInventoryFixture(fixture.runtime, scope,
      [agent("retained"), agent("deleted"), environment("Original environment")], { resourceTypes: [...powerPlatformResourceTypes] });
    await reconcileInventoryFixture(fixture.runtime, scope);
    const first = await inventorySelectionFixture(fixture.runtime, scope);
    const original = inventoryPresentation(first.raw);
    const retainedId = original.value.find(row => row.powerPlatformResource?.nativeId === "retained")!.id;

    await nativeInventoryFixture(fixture.runtime, scope, [agent("retained"), agent("added")], { resourceTypes: [agentType] });
    await reconcileInventoryFixture(fixture.runtime, scope);
    const second = await inventorySelectionFixture(fixture.runtime, scope);
    const current = inventoryPresentation(second.raw);
    expect(current.value.map(row => row.powerPlatformResource?.nativeId)).toEqual(["added", "retained"]);
    expect(current.value.find(row => row.powerPlatformResource?.nativeId === "retained")?.id).toBe(retainedId);
    expect(current.value.every(row => row.environment?.displayName === "Original environment")).toBe(true);
    const historical = await first.queries.page(first.selection.id, first.identity);
    expect(inventoryPresentation(historical).value).toEqual(original.value);
    expect(historical.freshness.state).toBe("stale");

    await nativeInventoryFixture(fixture.runtime, scope,
      [agent("retained"), agent("added"), environment("Replacement environment")], { resourceTypes: [...powerPlatformResourceTypes] });
    await reconcileInventoryFixture(fixture.runtime, scope);
    const third = inventoryPresentation((await inventorySelectionFixture(fixture.runtime, scope)).raw);
    expect(third.value.find(row => row.powerPlatformResource?.nativeId === "retained")?.id).toBe(retainedId);
    expect(third.value.every(row => row.environment?.displayName === "Replacement environment")).toBe(true);
    await nativeInventoryFixture(fixture.runtime, scope, [], { resourceTypes: [agentType] });
    await reconcileInventoryFixture(fixture.runtime, scope);
    const empty = inventoryPresentation((await inventorySelectionFixture(fixture.runtime, scope)).raw);
    expect(empty.value).toEqual([]);
    expect(empty.counts.total).toBe(0);
    expect(empty.sources.powerPlatform).toMatchObject({ state: "available",
      observation: { observedCount: 0, coverage: "covered", verification: { storedCount: 0, uniqueIdentityCount: 0 } } });
  });

  it("keeps equal-catalog-time native authority deterministic when the nonwinning scope is compacted later", async () => {
    const scope = { tenantId: "native-compaction-precedence", principalId: randomUUID() }, observedAt = new Date();
    const broad = await nativeInventoryFixture(fixture.runtime, scope,
      [{ nativeId: "broad-agent", environmentId, identifiers: [] }], { resourceTypes: [...powerPlatformResourceTypes], observedAt });
    const agents = await nativeInventoryFixture(fixture.runtime, scope,
      [{ nativeId: "agents-only", environmentId, identifiers: [] }], { resourceTypes: [agentType], observedAt });
    const winner = broad.scopeId < agents.scopeId ? broad : agents, loser = winner === broad ? agents : broad;
    const expected = winner === broad ? "broad-agent" : "agents-only";
    await reconcileInventoryFixture(fixture.runtime, scope);
    const before = await inventorySelectionFixture(fixture.runtime, scope), original = inventoryPresentation(before.raw);
    expect(original.value.map(row => row.powerPlatformResource?.nativeId)).toEqual([expected]);
    const input = inventoryInput(scope.principalId, "power_platform");
    input.scope.tenantId = scope.tenantId;
    input.scope.selector = inventorySelector({ domain: "power_platform",
      resourceTypes: loser === broad ? powerPlatformResourceTypes : [agentType] });
    await new InventoryGenerations(fixture.runtime).compact(input, loser, { authorize: async () => {} });
    await reconcileInventoryFixture(fixture.runtime, scope);
    const after = await inventorySelectionFixture(fixture.runtime, scope), compacted = inventoryPresentation(after.raw);
    expect(compacted.value.map(row => ({ id: row.id, nativeId: row.powerPlatformResource?.nativeId })))
      .toEqual(original.value.map(row => ({ id: row.id, nativeId: row.powerPlatformResource?.nativeId })));
    const current = await new InventoryIdentityQueries(fixture.runtime).read(client =>
      client.query(`${currentNativeInventorySql} SELECT native_id FROM native`, [scope.tenantId, scope.principalId, [agentType]]));
    expect(current.rows).toEqual([{ native_id: expected }]);
    await before.queries.selections.invalidate(before.selection.id, before.identity);
    await after.queries.selections.invalidate(after.selection.id, after.identity);
  });

  it.each(["resource_types", "environment_id", "expected_count", "role_scope", "omitted_fields"] as const)(
    "rejects post-publication changes to %s rather than changing saved evidence", async field => {
      const { scope, root } = await publishInventory();
      const selected = await inventorySelectionFixture(fixture.runtime, scope, {}, "power_platform");
      const changes = { resource_types: "ARRAY['microsoft.powerplatform/environments']::text[]",
        environment_id: "'different-environment'", expected_count: "1", role_scope: "'ai'", omitted_fields: "1" };
      await expect(fixture.operator.query(`UPDATE inventory_attempts SET ${field}=${changes[field]} WHERE generation_id=$1`, [root.baselineId]))
        .rejects.toThrow("inventory_attempt_immutable");
      expect((await selected.queries.page(selected.selection.id, selected.identity)).counts.total).toBe(2);
    });

  it("freezes requested source intent before the first provider page", async () => {
    const { scope, root, input } = await publishInventory();
    await expect(new InventoryGenerations(fixture.runtime).execute({ ...input, jobId: randomUUID() },
      { domain: "power_platform", mode: "baseline", channel: "catalog", resourceTypes: powerPlatformResourceTypes },
      async lease => { await fixture.runtime.query("UPDATE inventory_attempts SET environment_id=$2 WHERE generation_id=$1", [lease.id, environmentId]); },
      { authorize: async () => {} })).rejects.toThrow("inventory_intent_immutable");
    expect((await inventorySelectionFixture(fixture.runtime, scope, {}, "power_platform")).raw.freshness.sources[0].generation_id).toBe(root.baselineId);
  });

  it.each(["types", "environment", "fractional_count", "provider_total"] as const)(
    "rejects inconsistent streamed %s evidence and preserves the prior complete head", async change => {
      const { scope, root, input } = await publishInventory();
      const data = nativeIds.map(name => ({ name, tenantId: scope.tenantId,
        type: change === "types" ? "unsupported/resource" : agentType, properties: { environmentId, displayName: name } }));
      const provider = new PowerPlatformResourceQueryClient(async () => Response.json({
        totalRecords: change === "provider_total" ? 1 : 2, count: change === "fractional_count" ? 1.5 : 2, resultTruncated: 0, data,
      }));
      const requestedEnvironment = change === "environment" ? "22222222-2222-4222-8222-222222222222" : undefined;
      const next = { ...input, jobId: randomUUID(), scope: { ...input.scope,
        selector: inventorySelector({ domain: "power_platform", environmentId: requestedEnvironment, resourceTypes: powerPlatformResourceTypes }) } };
      await expect(new StreamedInventory(fixture.runtime, undefined, provider).powerPlatformCatalog(next, "synthetic-token",
        powerPlatformResourceTypes, { environmentId: requestedEnvironment, authorize: async () => {} })).rejects.toThrow();
      expect((await inventorySelectionFixture(fixture.runtime, scope, {}, "power_platform")).raw.freshness.sources[0].generation_id).toBe(root.baselineId);
    });

  it("does not claim that an unrequested environment source was verified empty", async () => {
    const { scope } = await publishInventory("unknown", [agentType]);
    const { raw } = await inventorySelectionFixture(fixture.runtime, scope, {}, "power_platform");
    expect(inventorySourceStatuses(raw.freshness.sources).powerPlatform.observation).toMatchObject({
      roleScope: "unknown", verification: { queriedTypes: [agentType] },
    });
    expect(raw.freshness.sources[0].resource_types).not.toContain("microsoft.powerplatform/environments");
  });

  it.each(["broad", "exact"] as const)("prevents deletion of published %s package rows instead of inventing an empty inventory", async kind => {
    const principalId = randomUUID(), store = new InventoryGenerations(fixture.runtime);
    await inventoryBaseline(store, principalId, 2);
    if (kind === "exact") await inventoryDelta(store, principalId, 1);
    const selected = await inventorySelectionFixture(fixture.runtime, { tenantId: "synthetic-tenant", principalId }, {}, "packages");
    const row = (await fixture.runtime.query(`SELECT r.generation_id,r.identity FROM package_record_rows r
      JOIN data_scope_epochs s ON s.id=r.scope_id JOIN data_generations g ON g.id=r.generation_id
      WHERE s.principal_id=$1 AND r.native_id=$2 ORDER BY g.observed_at DESC,g.created_at DESC LIMIT 1`,
    [principalId, selected.raw.value[0].id])).rows[0];
    expect(row).toBeDefined();
    await expect(fixture.operator.query("DELETE FROM package_record_rows WHERE generation_id=$1 AND identity=$2", [row.generation_id, row.identity]))
      .rejects.toThrow("inventory_content_pinned");
    expect((await selected.queries.page(selected.selection.id, selected.identity)).counts.total).toBe(2);
  });
});
