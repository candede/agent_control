import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { inventoryInput, inventorySelectionFixture, nativeInventoryFixture, reconcileInventoryFixture } from "../../scripts/inventoryFixtures.js";
import { selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import { InventoryGenerations } from "./inventoryGenerations.js";
import { InventoryQueries, type InventoryQuery } from "./inventoryQueries.js";
import { packageInventoryRecord } from "../services/inventoryRecordProjection.js";
import { allowlistedPackage } from "../services/packageObservation.js";
import { normalizePackageAuthoringTool, type CopilotPackageDetail } from "../types/copilotPackage.js";

describe("selected SQL package facets and filters", () => {
  let fixture: Awaited<ReturnType<typeof testDatabase>>;
  beforeAll(async () => { fixture = await testDatabase(); }, 30_000);
  afterAll(async () => { await fixture?.close(); });
  async function read(values: CopilotPackageDetail[], query: InventoryQuery = {}, selectedField?: Parameters<InventoryQueries["facets"]>[2]) {
    const input = inventoryInput(randomUUID()), store = new InventoryGenerations(fixture.runtime);
    const records = values.map(packageInventoryRecord);
    const root = await store.execute(input, { domain: "packages", mode: "baseline", channel: "catalog" }, async lease => {
      await store.visit(lease, "all");
      await store.appendBounded(lease, records);
      await store.acceptPage(lease, { token: "all", nextToken: null, records, rawCount: records.length,
        expectedCount: records.length, page: 1 }, records.length);
    }, { authorize: async () => {} });
    const reader = new InventoryQueries(fixture.runtime, "synthetic-selected-package-filter-secret");
    const identity = { ...selectionIdentity, principalId: input.scope.principalId! };
    const selected = await reader.capture(identity, root.scopeId, query);
    try {
      const page = await reader.page(selected.id, identity, { limit: 25, expectedQuery: query });
      const next = page.page.nextCursor ? await reader.page(selected.id, identity, {
        limit: 25, cursor: page.page.nextCursor, expectedQuery: query,
      }) : undefined;
      const previous = next?.page.previousCursor ? await reader.page(selected.id, identity, {
        limit: 25, cursor: next.page.previousCursor, expectedQuery: query,
      }) : undefined;
      return { selectionId: selected.id, page, next, previous,
        selectedFacet: selectedField ? await reader.facets(selected.id, identity, selectedField, { selected: true }) : undefined,
        platforms: await reader.facets(selected.id, identity, "platform"),
        availability: await reader.facets(selected.id, identity, "availableTo") };
    } finally { await reader.selections.invalidate(selected.id, identity); }
  }

  it.each([{ label: "null fact", publisher: null }, { label: "literal null tag", publisher: "~null" },
    { label: "maximum-width Unicode", publisher: "界".repeat(4096) }])(
    "resolves the exact captured publisher despite other filters: $label", async ({ publisher }) => {
    const result = await read([
      allowlistedPackage({ id: "selected", displayName: "Selected", isBlocked: false, ...(publisher === null ? {} : { publisher }) }),
      allowlistedPackage({ id: "other", displayName: "Other", isBlocked: false, publisher: "Different" }),
    ], { publisher, search: "No matching row" }, "publisher");
    expect(result.page.counts.filtered).toBe(0);
    expect(result.selectedFacet).toEqual({ value: [{ value: publisher, label: publisher ?? "Unknown" }], total: 1, nextCursor: null });
    });

  it("resolves a captured environment label in its selected root without listing or walking all environments", async () => {
    const scope = { tenantId: "selected-environment-label", principalId: randomUUID() };
    const environmentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await nativeInventoryFixture(fixture.runtime, scope, [
      { nativeId: "agent", environmentId, identifiers: [], displayName: "Agent" },
      { nativeId: environmentId, type: "microsoft.powerplatform/environments", identifiers: [], displayName: "Finance production" },
    ]);
    await reconcileInventoryFixture(fixture.runtime, scope);
    const selected = await inventorySelectionFixture(fixture.runtime, scope, { environmentId: environmentId.toUpperCase(), search: "No matching row" });
    expect(selected.raw.counts.filtered).toBe(0);
    expect(await selected.queries.facets(selected.selection.id, selected.identity, "environmentId", { selected: true }))
      .toEqual({ value: [{ value: environmentId, label: "Finance production" }], total: 1, nextCursor: null });
    await expect(selected.queries.facets(selected.selection.id, { ...selected.identity, principalId: randomUUID() }, "environmentId", { selected: true }))
      .rejects.toMatchObject({ code: "selection_invalidated" });
  });

  it("computes scoped availability overview independently of the filtered page in SQL", async () => {
    const result = await read([
      allowlistedPackage({ id: "a", displayName: "A", type: "LOB", isBlocked: false, availableTo: "all", supportedHosts: ["Teams"] }),
      allowlistedPackage({ id: "b", displayName: "B", type: "thirdParty", isBlocked: false, availableTo: "some", supportedHosts: ["SharePoint"] }),
      allowlistedPackage({ id: "c", displayName: "C", type: "shared", isBlocked: true, availableTo: "all", supportedHosts: ["Teams"] }),
      allowlistedPackage({ id: "d", displayName: "D", type: "firstParty", isBlocked: false, availableTo: "none", supportedHosts: ["Teams"] }),
    ], { inventoryScope: "catalog", host: "SharePoint" });
    expect(result.page.counts).toMatchObject({ total: 4, scoped: 4, filtered: 1 });
    expect(result.page.value.map(row => row.id)).toEqual(["b"]);
    expect(result.page.inventoryOverview).toEqual({ availableToUsers: 2, organizationCreated: 1, teamsAvailable: 1, createdOrAvailable: 1 });
  });

  it.each([
    { query: { view: "available", endUserAccess: "unavailable" }, ids: [] },
    { query: { view: "available", endUserAccess: "available" }, ids: ["available"] },
    { query: { view: "organization", relevance: "unknown" }, ids: [] },
    { query: { type: "custom", endUserAccess: "available", relevance: "organization" }, ids: ["available"] },
    { query: { view: "unknown", endUserAccess: "unknown" }, ids: ["unknown"] },
    { query: { management: "unknown", view: "availability_unknown" }, ids: ["unknown"] },
  ] satisfies Array<{ query: InventoryQuery; ids: string[] }>)(
    "intersects classification and relevance filters in the live SQL read: $query", async ({ query, ids }) => {
      const result = await read([
        allowlistedPackage({ id: "available", displayName: "Available", type: "custom", isBlocked: false, availableTo: "all" }),
        allowlistedPackage({ id: "unavailable", displayName: "Unavailable", type: "thirdParty", isBlocked: true, availableTo: "all" }),
        allowlistedPackage({ id: "unknown", displayName: "Unknown", type: "futureType", isBlocked: false }),
      ], query);
      expect(result.page.counts.filtered).toBe(ids.length);
      expect(result.page.value.map(row => row.id)).toEqual(ids);
    });

  it("filters and pages a maximum-width Unicode publisher without expanding shared selection metadata", async () => {
    const publisher = "🧭".repeat(2048);
    const values = Array.from({ length: 27 }, (_, index) => allowlistedPackage({
      id: `package-${String(index).padStart(2, "0")}`, displayName: `Package ${index}`, isBlocked: false, publisher,
    }));
    values.push(allowlistedPackage({ id: "other", displayName: "Other", isBlocked: false, publisher: "other" }));
    const result = await read(values, { publisher, sortBy: "publisher", sortDirection: "asc" });
    expect(result.page.counts).toMatchObject({ total: 28, filtered: 27 });
    expect(result.page.value.length).toBeGreaterThan(0);
    expect(result.page.value.length).toBeLessThan(25);
    expect([...result.page.value, ...result.next!.value].map(row => row.id)).toEqual(values.slice(0, 27).map(row => row.id));
    expect(Buffer.byteLength(JSON.stringify(result.page))).toBeLessThanOrEqual(1_048_576);
    expect(result.previous?.value).toEqual(result.page.value);
    expect(Buffer.byteLength(result.page.page.nextCursor!)).toBeLessThanOrEqual(4096);
    const metadata = (await fixture.runtime.query(`SELECT selection.query_json,
      octet_length(selection.query_json::text) AS metadata_bytes,context.query_values
      FROM data_read_selections selection JOIN inventory_read_contexts context ON context.selection_id=selection.id
      WHERE selection.id=$1`, [result.selectionId])).rows[0];
    expect(metadata.query_json).toEqual({ inventoryQuery: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(metadata.metadata_bytes).toBeLessThan(2048);
    expect(metadata.query_values.publisher).toBe(publisher);
    await expect(fixture.operator.query("UPDATE inventory_read_contexts SET query_values='{}' WHERE selection_id=$1",
      [result.selectionId])).rejects.toThrow("inventory_query_context_immutable");
  });

  it.each([
    ["Copilot Studio", "copilotstudio", "Copilot Studio"],
    ["MicrosoftCopilotStudio", "copilotstudio", "Copilot Studio"],
    ["Microsoft Copilot Studio", "copilotstudio", "Copilot Studio"],
    ["Custom SDK", "customsdk", "Custom SDK"],
    ["CustomSDK", "customsdk", "Custom SDK"],
    ["Copilot Studio Lite", "microsoft365copilotagentbuilder", "Microsoft 365 Copilot Agent Builder"],
    ["MicrosoftCopilotStudioLite", "microsoft365copilotagentbuilder", "Microsoft 365 Copilot Agent Builder"],
  ])("filters and counts canonical authoring metadata for %s", async (platform, canonical, label) => {
    const result = await read([allowlistedPackage({ id: "package", displayName: "Package", isBlocked: false, platform })], { platform }, "platform");
    expect(normalizePackageAuthoringTool(platform)).toBe(canonical);
    expect(result.platforms.value).toEqual([{ value: canonical, label }]);
    expect(result.selectedFacet).toEqual({ value: [{ value: canonical, label }], total: 1, nextCursor: null });
    expect(result.page.counts).toMatchObject({ total: 1, filtered: 1 });
    expect(result.page.value.map(value => value.id)).toEqual(["package"]);
  });

  it.each([
    ["Copilot Studio", ["studio"]],
    ["Microsoft 365 Copilot Agent Builder", ["builder", "description", "lite", "microsoft-lite"]],
    ["Copilot Studio Lite", ["builder", "description", "lite", "microsoft-lite"]],
    ["Custom SDK", ["custom"]],
    ["Missing tool", []],
  ])("returns only packages belonging to the %s platform", async (platform, expected) => {
    const values = [
      ...[["studio", "Microsoft Copilot Studio"], ["lite", "Copilot Studio Lite"], ["microsoft-lite", "MicrosoftCopilotStudioLite"],
        ["builder", "Microsoft 365 Copilot Agent Builder"], ["custom", "CustomSDK"], ["blank", ""]]
        .map(([id, platform]) => allowlistedPackage({ id, displayName: id, isBlocked: false, platform })),
      allowlistedPackage({ id: "description", displayName: "Description", isBlocked: false, shortDescription: "  Built using Copilot Studio Lite.  " }),
    ];
    const result = await read(values, { platform: platform as string });
    expect(result.page.counts).toMatchObject({ total: 7, filtered: expected.length });
    expect(result.page.value.map(value => value.id).sort()).toEqual(expected);
  });

  it.each([{ platform: "MicrosoftCopilotStudio" }, { shortDescription: "Built using Microsoft Copilot Studio." }])(
    "uses the same authoring normalization for facets and detail metadata: %j", async fields => {
      const result = await read([allowlistedPackage({ id: "package", displayName: "Package", isBlocked: false, ...fields })]);
      expect(result.platforms.value).toEqual([{ value: "copilotstudio", label: "Copilot Studio" }]);
    },
  );

  it.each(["all", "everyone", "allowedForAll", "availableToAll", "deployedToAll", "installedForAll",
    "some", "allowedForSome", "availableToSome", "deployedToSome", "installedForSome", " ALLOWED_FOR-ALL ", "AVAILABLE TO SOME"])(
    "offers and applies the combined assignment facet for %s", async availableTo => {
      const value = allowlistedPackage({ id: "package", displayName: "Package", isBlocked: false, availableTo });
      const result = await read([value], { availableTo: { kind: "some-or-all" } });
      expect(result.availability.value).toEqual(expect.arrayContaining([
        { value: availableTo, label: availableTo }, { value: { kind: "some-or-all" }, label: "Allowed for Some or All" },
      ]));
      expect(result.page.counts.filtered).toBe(1);
      expect(result.page.value.map(value => value.id)).toEqual(["package"]);
    },
  );

  it.each([undefined, "", "none", "allowedForNoOne", "deployedToNone", "unknownFutureValue", "futureStatus"])(
    "does not classify unknown or unavailable assignment %s as some/all", async availableTo => {
      const value = allowlistedPackage({ id: "package", displayName: "Package", isBlocked: false, availableTo });
      const result = await read([value], { availableTo: { kind: "some-or-all" } });
      expect(result.availability.value).toEqual([{ value: availableTo || null, label: availableTo || "Unknown" }]);
      expect(result.page.counts).toMatchObject({ total: 1, filtered: 0 });
      expect(result.page.value).toEqual([]);
    },
  );

  it.each(["all", "__some_or_all__", "available:__some_or_all__", "available:all", "available:__unknown__", "__unknown__", "~null", "~some-or-all"])(
    "does not mistake literal provider assignment %s for an unrestricted, combined, or unknown choice", async availableTo => {
      const values = [
        allowlistedPackage({ id: "literal", displayName: "Literal", isBlocked: false, availableTo }),
        allowlistedPackage({ id: "unknown", displayName: "Unknown", isBlocked: false }),
      ];
      const result = await read(values, { availableTo });
      expect(result.page.counts).toMatchObject({ total: 2, filtered: 1 });
      expect(result.page.value.map(value => value.id)).toEqual(["literal"]);
      expect(result.availability.value).toContainEqual({ value: availableTo, label: availableTo });
      expect((await read(values, { availableTo: null })).page.value.map(value => value.id)).toEqual(["unknown"]);
    },
  );

  it.each(["type", "publisher", "host", "platform"] as const)(
    "distinguishes unrestricted, unknown, and literal reserved-looking %s values", async field => {
      const values = ["all", "__unknown__", "~null", undefined].map((value, index) => allowlistedPackage({
        id: `p${index}`, displayName: `P${index}`, isBlocked: false,
        ...(field === "host" ? { supportedHosts: value === undefined ? [] : [value] } : { [field]: value }),
      }));
      expect((await read(values)).page.counts.filtered).toBe(4);
      for (const [index, literal] of ["all", "__unknown__", "~null", null].entries()) {
        const selected = await read(values, { [field]: literal });
        expect(selected.page.counts).toMatchObject({ total: 4, filtered: 1 });
        expect(selected.page.value.map(value => value.id)).toEqual([`p${index}`]);
      }
    },
  );

  it("retains combined assignment criteria through selected next and previous pages", async () => {
    const result = await read(Array.from({ length: 51 }, (_, index) => allowlistedPackage({
      id: `p${index.toString().padStart(3, "0")}`, displayName: `P${index.toString().padStart(3, "0")}`, isBlocked: false, availableTo: "all",
    })), { availableTo: { kind: "some-or-all" } });
    expect(result.page.counts.filtered).toBe(51);
    expect(result.page.value).toHaveLength(25);
    expect(result.next?.value).toHaveLength(25);
    expect(result.next?.counts.filtered).toBe(51);
    expect(result.previous?.value).toEqual(result.page.value);
  });
});
