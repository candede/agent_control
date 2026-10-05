import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { inventoryInput } from "../../scripts/inventoryFixtures.js";
import { selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import { InventoryGenerations } from "./inventoryGenerations.js";
import { InventoryQueries } from "./inventoryQueries.js";
import { packageInventoryRecord } from "../services/inventoryRecordProjection.js";
import { allowlistedPackage } from "../services/packageObservation.js";

describe("selected package inventory operation references", () => {
  let fixture: Awaited<ReturnType<typeof testDatabase>>;
  beforeAll(async () => { fixture = await testDatabase(); }, 30_000);
  afterAll(async () => { await fixture?.close(); });

  it("applies literal, actor-scoped, retained bulk references before exact counting and keyset paging", async () => {
    const input = inventoryInput(randomUUID());
    const identity = { ...selectionIdentity, principalId: input.scope.principalId! };
    const store = new InventoryGenerations(fixture.runtime);
    const ids = ["PKG", "pkg", "second", "other-principal", "other-tenant", "expired", "future", "single", "prefix-wildcard"];
    const records = ids.map(id => packageInventoryRecord(allowlistedPackage({ id, displayName: id, isBlocked: false })));
    const root = await store.execute(input, { domain: "packages", mode: "baseline", channel: "catalog" }, async lease => {
      await store.visit(lease, "complete");
      await store.appendBounded(lease, records);
      await store.acceptPage(lease, { token: "complete", nextToken: null, records, rawCount: records.length,
        expectedCount: records.length, page: 1 }, records.length);
    }, { authorize: async () => {} });
    const now = Date.now();
    const events = [
      { id: "PKG", operation: "REF_CASE-first" },
      { id: "PKG", operation: "ref_case-duplicate" },
      { id: "second", operation: "ref_case-second" },
      { id: "pkg", operation: "unrelated" },
      { id: "other-principal", principal: "different-actor" },
      { id: "other-tenant", tenant: "different-tenant" },
      { id: "expired", at: new Date(now - 91 * 86_400_000) },
      { id: "future", at: new Date(now + 86_400_000) },
      { id: "single", scope: "single" },
      { id: "prefix-wildcard", operation: "REFxCASE-wildcard" },
      { id: "outside-inventory" },
    ];
    for (const event of events) await fixture.runtime.query(`INSERT INTO audit_events(
      id,event_id,operation_id,tenant_id,principal_id,actor_username,actor_name,scope,action,agent_id,started_at,observed_at,completed_at,status,request_path,target_blocked_state)
      VALUES($1,$2,$3,$4,$5,'actor@example.invalid','Synthetic actor',$6,'block',$7,$8,$8,$8,'succeeded','/api/agents/block',true)`,
    [randomUUID(), randomUUID(), event.operation ?? "REF_CASE-excluded", event.tenant ?? identity.tenantId,
      event.principal ?? identity.principalId, event.scope ?? "bulk", event.id, event.at ?? new Date(now)]);
    const reader = new InventoryQueries(fixture.runtime, "synthetic-operation-reference-secret");
    const selected = await reader.capture(identity, root.scopeId, { inventoryScope: "catalog", operationIdPrefix: "ref_case" });
    const first = await reader.page(selected.id, identity, { limit: 1 });
    expect(first.counts).toMatchObject({ total: ids.length, scoped: ids.length, filtered: 2 });
    expect(first.value.map(value => value.id)).toEqual(["PKG"]);
    expect(first.page.nextCursor).not.toBeNull();
    const second = await reader.page(selected.id, identity, { limit: 1, cursor: first.page.nextCursor! });
    expect(second.value.map(value => value.id)).toEqual(["second"]);
    expect(second.counts.filtered).toBe(2);
    expect(second.page.nextCursor).toBeNull();
    await expect(reader.page(selected.id, { ...identity, principalId: "different-actor" }, { limit: 1 }))
      .rejects.toMatchObject({ code: "selection_invalidated" });
  });
});
