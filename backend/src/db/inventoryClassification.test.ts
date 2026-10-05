import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { initializeSchema } from "../../scripts/database.js";
import { testDatabase } from "../../scripts/testDatabase.js";
import { inventoryInput, packageRecord } from "../../scripts/inventoryFixtures.js";
import { selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import { InventoryGenerations } from "./inventoryGenerations.js";
import { InventoryQueries } from "./inventoryQueries.js";
import { verifySchema } from "./schema.js";
import { powerPlatformInventoryRecord, type InventoryRecord } from "../services/inventoryRecordProjection.js";

describe("typed inventory classification", () => {
  it.each(["packages", "power_platform"] as const)("publishes typed %s evidence and preserves it on repeated initialization", async domain => {
    const fixture = await testDatabase();
    try {
      const principal = randomUUID(), input = inventoryInput(principal, domain);
      const record = domain === "packages" ? packageRecord(0)
        : powerPlatformInventoryRecord({
          tenantId: input.scope.tenantId, nativeId: "native", type: "microsoft.copilotstudio/agents",
          location: null, displayName: "Native", environmentId: null, createdAt: null, createdBy: null,
          lastPublishedAt: null, sourceSystem: "power_platform", authoringTool: null, creatorType: "unknown",
          agentKind: "copilot_studio_agent", lifecycle: "unknown", identityConfidence: "partial",
          identifiers: [], provenance: {}, details: { lastModifiedAt: "2026-10-01T12:34:56.789Z" }, unknownFieldCount: 0,
        });
      const store = new InventoryGenerations(fixture.runtime);
      const intent = { domain, mode: "baseline" as const, channel: "catalog" as const,
        ...(domain === "power_platform" ? { resourceTypes: ["microsoft.copilotstudio/agents"] } : {}) };
      if (domain === "power_platform") input.scope.selector = JSON.stringify(["", intent.resourceTypes]);
      const table = domain === "packages" ? "package_record_rows" : "power_platform_record_rows";
      const root = await store.execute(input, intent, async lease => {
        await store.visit(lease, "catalog");
        await store.append(lease, [record]);
        await store.acceptPage(lease, { token: "catalog", nextToken: null, records: [record], rawCount: 1, expectedCount: 1, page: 1 }, 1);
      }, { authorize: async () => {} });
      const before = (await fixture.runtime.query(`SELECT content_hash,residual FROM ${table}`)).rows;
      const facts = (await fixture.runtime.query("SELECT * FROM inventory_facts ORDER BY ordinal")).rows;
      await initializeSchema(fixture.operator);
      await verifySchema(fixture.runtime);
      expect((await fixture.runtime.query(`SELECT content_hash,residual FROM ${table}`)).rows).toEqual(before);
      expect((await fixture.runtime.query("SELECT * FROM inventory_facts ORDER BY ordinal")).rows).toEqual(facts);
      const saved = (await fixture.runtime.query(`SELECT presence,link_state,availability,management,modified_at FROM ${table}`)).rows[0];
      expect(saved).toMatchObject({ presence: record.presence, link_state: record.link_state,
        availability: record.availability, management: record.management });
      expect(saved.modified_at?.toISOString() ?? null).toBe(record.modified_at);
      const reader = new InventoryQueries(fixture.runtime, "synthetic-classification-cursor-secret-32");
      const identity = { ...selectionIdentity, principalId: principal };
      const selection = await reader.capture(identity, root.scopeId);
      const page = await reader.page(selection.id, identity);
      expect(page.value).toHaveLength(1);
      expect(page.value[0]).toMatchObject({ presence: record.presence, linkState: record.link_state, availability: record.availability });
    } finally { await fixture.close(); }
  }, 30_000);

  it("rejects invalid or incomplete classifications and retired scalar writes", async () => {
    const fixture = await testDatabase();
    try {
      const store = new InventoryGenerations(fixture.runtime);
      for (const invalid of [
        { ...packageRecord(0), presence: "both" as const },
        { ...packageRecord(0), management: null },
      ]) {
        await expect(store.execute(inventoryInput(), { domain: "packages", mode: "baseline", channel: "catalog" },
          lease => store.append(lease, [invalid]).then(() => {}), { authorize: async () => {} }))
          .rejects.toMatchObject({ code: "23514" });
      }
      const valid: InventoryRecord = packageRecord(0);
      await expect(store.execute(inventoryInput(), { domain: "packages", mode: "baseline", channel: "catalog" }, async lease => {
        await store.append(lease, [valid]);
        await fixture.runtime.query(`INSERT INTO inventory_facts(generation_id,scope_id,tenant_id,identity,schema_version,ordinal,kind,value)
          VALUES($1,$2,$3,$4,1,9999,'presence','both')`, [lease.id, lease.scopeId, lease.tenantId, valid.identity]);
      }, { authorize: async () => {} })).rejects.toThrow("inventory_scalar_fact_retired");
    } finally { await fixture.close(); }
  }, 30_000);
});
