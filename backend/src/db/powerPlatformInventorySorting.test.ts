import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { seedSelectedInventory } from "../../scripts/selectedInventoryFixture.js";
import type { PowerPlatformResource } from "../types/powerPlatformInventory.js";
import { NativeInventory } from "./nativeInventory.js";
import { nativeInventoryKey } from "../services/inventoryRecordProjection.js";

let database: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => { database = await testDatabase(); });
afterAll(async () => { await database?.close(); });
function resource(nativeId: string, fields: Partial<PowerPlatformResource> = {}): PowerPlatformResource {
  return { nativeId, tenantId: "synthetic", environmentId: null, type: "microsoft.copilotstudio/agents",
    displayName: null, location: null, createdAt: null, createdBy: null, lastPublishedAt: null, sourceSystem: "power_platform",
    authoringTool: null, creatorType: "unknown", agentKind: "copilot_studio_agent", lifecycle: "unknown",
    identityConfidence: "exact_native", identifiers: [], provenance: {}, details: {}, unknownFieldCount: 0, ...fields };
}

describe("selected native source sorting and current exact controls", () => {
  it.each((["displayName", "environment", "createdAt", "lastPublishedAt"] as const).flatMap(sortBy =>
    (["asc", "desc"] as const).map(sortDirection => ({ sortBy, sortDirection }))))(
    "sorts $sortBy $sortDirection before bounded keysets, with nulls last and previous-page round trips", async query => {
      const source = await seedSelectedInventory(database.runtime, { resources: [
        resource("a", { displayName: "Alpha", environmentId: "environment-a",
          createdAt: "2026-09-01T00:00:00Z", lastPublishedAt: "2026-09-01T00:00:00Z" }),
        resource("b", { displayName: "Beta", environmentId: "environment-b",
          createdAt: "2026-09-02T00:00:00Z", lastPublishedAt: "2026-09-02T00:00:00Z" }),
        resource("tie", { displayName: "Beta", environmentId: "environment-b",
          createdAt: "2026-09-01T20:00:00-04:00", lastPublishedAt: "2026-09-02T04:00:00+04:00" }),
        resource("unknown", { displayName: "Z unknown" }),
      ] });
      const selected = await source.select(query, 2, "power_platform");
      expect(selected.raw.counts).toMatchObject({ total: 4, filtered: 4 });
      const second = await source.queries.page(selected.selection.id, source.identity, { limit: 2, cursor: selected.raw.page.nextCursor! });
      expect(second.page.nextCursor).toBeNull();
      expect(second.page.previousCursor).toBeTruthy();
      const previous = await source.queries.page(selected.selection.id, source.identity, { limit: 2, cursor: second.page.previousCursor! });
      expect(previous.value).toEqual(selected.raw.value);
      const rows = [...selected.raw.value, ...second.value];
      const value = (row: PowerPlatformResource) => query.sortBy === "displayName" ? row.displayName
        : query.sortBy === "environment" ? row.environmentId
        : row[query.sortBy] === null ? null : Date.parse(row[query.sortBy]!);
      const expected = [...source.input.resources!].sort((left, right) => {
        const a = value(left), b = value(right), direction = query.sortDirection === "desc" ? -1 : 1;
        const tie = Buffer.compare(Buffer.from(nativeInventoryKey(left)), Buffer.from(nativeInventoryKey(right))) * direction;
        if (a === null || b === null) return a === b ? tie : a === null ? 1 : -1;
        const order = typeof a === "number" && typeof b === "number" ? a - b
          : Buffer.compare(Buffer.from(String(a).normalize("NFKC").toLowerCase()), Buffer.from(String(b).normalize("NFKC").toLowerCase()));
        return order * direction || tie;
      }).map(row => row.nativeId);
      const ids = rows.map(row => row.nativeId);
      expect(ids).toEqual(expected);
      expect(new Set(ids).size).toBe(4);
    });

  it("rejects equal-sized results containing one ambiguous native identity and one absent identity", async () => {
    const source = await seedSelectedInventory(database.runtime, { resources: [
      resource("duplicate", { environmentId: "environment-a" }), resource("duplicate", { environmentId: "environment-b" }),
    ] });
    const controls = new NativeInventory(database.runtime);
    await expect(controls.getQuarantineSelection(source.scope, source.resources!.baselineId, ["duplicate", "absent"]))
      .rejects.toMatchObject({ code: "quarantine_target_ambiguous" });
    await expect(controls.getQuarantineSelection(source.scope, source.resources!.baselineId, ["absent"]))
      .rejects.toMatchObject({ code: "quarantine_target_unavailable" });
  });
});
