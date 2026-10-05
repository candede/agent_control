import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { parse } from "csv-parse/sync";
import { testDatabase } from "../../scripts/testDatabase.js";
import { seedSelectedInventory, selectedInventoryCsv } from "../../scripts/selectedInventoryFixture.js";
import { fixtureDirectoryUser } from "../../scripts/userSourceFixture.js";
import type { InventoryQuery } from "../db/inventoryQueries.js";
import { inventoryPresentation } from "./inventoryPresentation.js";
import { allowlistedPackage } from "./packageObservation.js";
import { agentColumnValue } from "../types/agentPresentation.js";
import { unifiedAgentSortKeys, unifiedAgentInventoryScopes, unifiedAgentRecordId,
  type UnifiedAgentRecord } from "../types/unifiedAgents.js";
import type { CopilotPackageDetail } from "../types/copilotPackage.js";
import type { PowerPlatformResource } from "../types/powerPlatformInventory.js";

const environmentA = "11111111-1111-4111-8111-111111111111";
const environmentB = "22222222-2222-4222-8222-222222222222";
const botA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ownerA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ownerB = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
type Scenario = Awaited<ReturnType<typeof seedSelectedInventory>>;
let database: Awaited<ReturnType<typeof testDatabase>>;
let scoped: Scenario, quick: Scenario, sortable: Scenario;
const identify = (record: UnifiedAgentRecord) => record.packages[0]?.id ?? record.powerPlatformResource!.nativeId;
function packageValue(id: string, displayName = id, linked = false): CopilotPackageDetail {
  return { ...allowlistedPackage({
    id, displayName, isBlocked: id.endsWith("blocked"), availableTo: "unknownFutureValue", deployedTo: "allowedForNoOne",
    platform: "Copilot Studio",
    ...(linked ? { elementDetails: [{ elementType: "AgentMetadatas", elements: [{
      id: "metadata", definition: JSON.stringify({ SourceIds: { EnvironmentId: environmentA, CdsBotId: botA } }),
    }] }] } : {}),
  }), identityDetailsCollected: true };
}
function resource(environmentId: string | null, nativeId = "shared-native"): PowerPlatformResource {
  return {
    tenantId: "fixture", nativeId, type: "microsoft.copilotstudio/agents", environmentId, location: "unitedstates",
    displayName: "Same displayed name", createdAt: "2026-09-01T00:00:00Z", createdBy: null, lastPublishedAt: null,
    sourceSystem: "power_platform", authoringTool: "Copilot Studio", creatorType: "unknown", agentKind: "copilot_studio_agent",
    lifecycle: "published", identityConfidence: "exact_native", provenance: {}, details: {}, unknownFieldCount: 0,
    identifiers: [...(environmentId ? [{ kind: "environment_id" as const, value: environmentId }] : []),
      { kind: "power_platform_resource_id", value: nativeId },
      ...(environmentId === environmentA ? [{ kind: "cds_bot_id" as const, value: botA }] : [])],
  };
}
function environment(id: string, name: string): PowerPlatformResource {
  return { ...resource(null, id), type: "microsoft.powerplatform/environments", displayName: name, identifiers: [] };
}
async function csvRows(scenario: Scenario, selected: Awaited<ReturnType<Scenario["select"]>>) {
  return parse((await selectedInventoryCsv(database.runtime, scenario, selected.selection)).csv,
    { bom: true, columns: true }) as Record<string, string>[];
}
async function pages(scenario: Scenario, selected: Awaited<ReturnType<Scenario["select"]>>, limit = 2) {
  const values = [...selected.page!.value];
  let previous = selected.raw, cursor = previous.page.nextCursor;
  while (cursor) {
    const next = await scenario.queries.page(selected.selection.id, scenario.identity, { limit, cursor });
    if (next.page.previousCursor) {
      const back = await scenario.queries.page(selected.selection.id, scenario.identity, { limit, cursor: next.page.previousCursor });
      expect(back.value).toEqual(previous.value);
    }
    values.push(...inventoryPresentation(next).value);
    previous = next;
    cursor = next.page.nextCursor;
    if (values.length > 1000) throw new Error("tiny_oracle_page_limit");
  }
  expect(values).toHaveLength(selected.raw.counts.filtered);
  return values;
}

beforeAll(async () => {
  database = await testDatabase();
  scoped = await seedSelectedInventory(database.runtime, {
    packages: [
      { ...packageValue("linked-a", "Catalog linked", true), availableTo: "all", supportedHosts: ["Teams"] },
      packageValue("linked-b-blocked", "Catalog linked", true),
      { ...packageValue("available", "Catalog available"), availableTo: "some", platform: "Microsoft 365 Copilot Agent Builder" },
      { ...packageValue("unavailable", "Catalog unavailable"), availableTo: "none", platform: "Microsoft 365 Copilot Agent Builder" },
    ],
    resources: [{ ...resource(environmentA), displayName: "Catalog linked" },
      { ...resource(environmentB), displayName: "Native only", authoringTool: "Zebra SDK" },
      environment(environmentA, "Catalog environment"), environment(environmentB, "Native environment")],
  });
  const control = { snapshotId: "synthetic-control", observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString() };
  quick = await seedSelectedInventory(database.runtime, {
    packages: [
      { ...packageValue("first", "First"), type: "microsoft", platform: undefined, authoringTool: null, availableTo: "all" },
      { ...packageValue("vendor", "Vendor"), type: "external", platform: undefined, authoringTool: null, availableTo: "some" },
      { ...packageValue("personal", "Personal"), type: "custom", platform: "Copilot Studio Lite", availableTo: "none", deployedTo: "none" },
      ...["studio-low", "studio-high", "admin-blocked"].map(id => ({
        ...packageValue(id), type: "external", availableTo: "all", deployedTo: "none", publisher: "Vendor",
        supportedHosts: ["Teams"], controlObservations: { access: control },
      })),
      { ...packageValue("generic", "Generic"), type: "external", availableTo: "some", deployedTo: "all",
        acquireUsersAndGroups: [{ resourceId: "installation-group", resourceType: "group" }] },
      { ...packageValue("unknown", "Unknown"), platform: undefined, authoringTool: null },
      { ...packageValue("zero", "Zero"), type: "external", availableTo: "some" },
    ],
    resources: [{ ...resource(environmentB, "native"), authoringTool: null }],
    usage: [["vendor", 6], ["personal", 2], ["studio-low", 2], ["studio-high", 10], ["admin-blocked", 3], ["zero", 0]]
      .map(([id, responses]) => ({ id: String(id), responses: Number(responses) })),
  });
  sortable = await seedSelectedInventory(database.runtime, {
    observedAt: new Date(Date.now() - 60_000),
    packages: [
      { ...packageValue("sort-a", "Ålpha"), type: "firstParty", publisher: "Beta", platform: "Custom SDK",
        version: "3", supportedHosts: ["Teams"], availableTo: "all", lastModifiedDateTime: "2026-09-16T02:00:00+04:00" },
      { ...packageValue("sort-b", "ＡLPHA"), type: "thirdParty", publisher: "Alpha", version: "1", availableTo: "none",
        supportedHosts: ["Outlook"], lastModifiedDateTime: "2026-09-15T22:00:00Z" },
      { ...packageValue("sort-null", "Ω unknown"), platform: undefined, authoringTool: null },
    ],
    resources: [
      { ...resource(environmentA, "sort-native-a"), displayName: "Native A", createdBy: ownerA, lastPublishedAt: "2026-09-18T00:00:00Z",
        details: { ownerId: ownerA, model: "Model Z", authentication: "none", channels: ["Teams"],
          isQuarantined: false, isManaged: true, isWebSearchEnabledForKnowledge: true, orchestration: "generative" } },
      { ...resource(environmentB, "sort-native-b"), displayName: "Native B", createdBy: ownerB, authoringTool: "Copilot Studio Lite",
        details: { ownerId: ownerB, model: "Model A", authentication: "aad", channels: [], isQuarantined: true, isManaged: false } },
      { ...resource(null, "sort-native-null"), displayName: "Native unknown", authoringTool: null, lifecycle: "unknown", createdAt: null, location: null },
      environment(environmentA, "Zebra environment"), environment(environmentB, "Alpha environment"),
    ],
    directory: [fixtureDirectoryUser(ownerA, "Zebra Person", "zebra@example.invalid"), fixtureDirectoryUser(ownerB, "Alpha Person", "alpha@example.invalid")],
    usage: [{ id: "sort-a", responses: 10, users: 2 }, { id: "sort-b", responses: 2, users: 1 }, { id: "sort-null", responses: 0, users: 0 }],
  });
}, 30_000);
afterAll(async () => { await database?.close(); });
afterEach(async () => {
  for (const scenario of [scoped, quick, sortable]) await scenario?.releaseSelections();
});

describe("selected canonical inventory SQL parity", () => {
  it.each(["displayName", "publisher", "versions"] as const)(
    "preserves the existing English base-sensitivity and numeric-version comparator for %s", async sortBy => {
      const scenario = await seedSelectedInventory(database.runtime, { packages: [
        { ...packageValue("accent-a", "éclair"), publisher: "alpha", version: "2" },
        { ...packageValue("accent-b", "zebra"), publisher: "Beta", version: "10" },
      ] });
      for (const sortDirection of ["asc", "desc"] as const) {
        const selected = await scenario.select({ sortBy, sortDirection }, 1);
        expect((await pages(scenario, selected, 1)).map(identify))
          .toEqual(sortDirection === "asc" ? ["accent-a", "accent-b"] : ["accent-b", "accent-a"]);
      }
    });
  it.each(["firstParty", "thirdParty", "shared", "lob", "microsoft", "external", "custom", "futureType", "__proto__"])(
    "preserves raw Graph type %s through SQL counts, keysets, facets and durable CSV", async type => {
      const types = ["firstParty", "thirdParty", "shared", "lob", "microsoft", "external", "custom", "futureType", "__proto__"];
      const scenario = await seedSelectedInventory(database.runtime, {
        packages: [...types.flatMap(type => [0, 1].map(index => ({
          ...packageValue(`${type}-${index}`, `Analyst ${index}`), type, publisher: "Microsoft Corporation", availableTo: index ? "none" : "all",
        }))), packageValue("missing-type")], resources: [resource(environmentB)],
      });
      const selected = await scenario.select({ type, inventoryScope: "catalog" }, 1);
      expect(selected.raw.counts).toMatchObject({ total: 20, scoped: 19, filtered: 2 });
      expect(selected.page!.value.map(identify)).toEqual([`${type}-0`]);
      expect((await pages(scenario, selected, 1)).map(identify)).toEqual([`${type}-0`, `${type}-1`]);
      const facets = await scenario.queries.facets(selected.selection.id, scenario.identity, "type");
      expect(facets.value.map(option => option.value)).toEqual(expect.arrayContaining([...types, null]));
      const rows = (await csvRows(scenario, selected)).filter(row => row.recordType === "agent");
      expect(rows.map(row => row.origin)).toEqual([type, type]);
      expect((await scenario.select({ type, endUserAccess: "available" })).page!.value.map(identify)).toEqual([`${type}-0`]);
      expect((await scenario.select({ type: type.toUpperCase() })).raw.counts.filtered).toBe(0);
      expect((await scenario.select({ type, inventoryScope: "power_platform_only" })).raw.counts.filtered).toBe(0);
    });

  it.each([
    { inventoryScope: "catalog", total: 3, linked: 1, graphOnly: 2, powerPlatformOnly: 0, environments: [environmentA],
      overview: { availableToUsers: 2, organizationCreated: 1, teamsAvailable: 1, createdOrAvailable: 1 } },
    { inventoryScope: "power_platform_only", total: 1, linked: 0, graphOnly: 0, powerPlatformOnly: 1, environments: [environmentB],
      overview: { availableToUsers: 0, organizationCreated: 1, teamsAvailable: 0, createdOrAvailable: 1 } },
    { inventoryScope: "all", total: 4, linked: 1, graphOnly: 2, powerPlatformOnly: 1, environments: [environmentA, environmentB],
      overview: { availableToUsers: 2, organizationCreated: 2, teamsAvailable: 1, createdOrAvailable: 2 } },
  ] as const)("keeps global, $inventoryScope, filtered and source counts distinct", async expected => {
    const selected = await scoped.select({ inventoryScope: expected.inventoryScope }, 1);
    expect(selected.raw.counts).toMatchObject({ total: 4, scoped: expected.total, filtered: expected.total });
    expect(selected.page).toMatchObject({
      summary: { total: 4, linked: 1, graphOnly: 2, powerPlatformOnly: 1 },
      scopeSummary: { total: expected.total, linked: expected.linked, graphOnly: expected.graphOnly, powerPlatformOnly: expected.powerPlatformOnly },
      inventoryOverview: expected.overview, identityCollection: { checkedPackages: 4, pendingPackages: 0 },
      verification: { status: "verified", graphPackageCount: 4, powerPlatformAgentCount: 2, representedSourceCount: 6, uniqueSourceCount: 6 },
    });
    expect(selected.raw.value).toHaveLength(1);
    const facets = await scoped.queries.facets(selected.selection.id, scoped.identity, "environmentId");
    expect(facets.value.map(value => value.value).filter(value => value !== null)).toEqual(expected.environments);
    const filtered = await scoped.select({ inventoryScope: expected.inventoryScope, search: "does not exist" });
    expect(filtered.raw.counts).toMatchObject({ total: 4, scoped: expected.total, filtered: 0 });
    expect(filtered.page!.inventoryOverview).toEqual(selected.page!.inventoryOverview);
    expect(filtered.page!.summary).toEqual(selected.page!.summary);
    expect(filtered.page!.sources).toEqual(selected.page!.sources);
  });

  it.each(unifiedAgentInventoryScopes)("composes %s with every source filter and durable export", async inventoryScope => {
    const counts = inventoryScope === "catalog" ? [3, 3, 1, 1] : inventoryScope === "power_platform_only" ? [1, 0, 1, 0] : [4, 3, 2, 1];
    for (const [index, source] of (["all", "graph_packages", "power_platform", "both"] as const).entries()) {
      const selected = await scoped.select({ inventoryScope, source, sortDirection: "desc" }, 1);
      expect(selected.raw.counts).toMatchObject({ total: 4, scoped: counts[0], filtered: counts[index] });
      const all = await pages(scoped, selected, 1);
      const rows = (await csvRows(scoped, selected)).filter(row => row.recordType === "agent");
      expect(rows.map(row => row.agentId)).toEqual(all.map(row => row.id));
    }
  });

  it.each([
    { query: { view: "first_party", endUserAccess: "available", management: "unknown" }, expected: ["first"] },
    { query: { view: "third_party", reportedUsage: "used", management: "unknown" }, expected: ["vendor"] },
    { query: { view: "user_managed", endUserAccess: "unavailable", reportedUsage: "used", relevance: "organization" }, expected: ["personal"] },
    { query: { view: "copilot_studio", endUserAccess: "available", reportedUsage: "used", management: "organization_managed", relevance: "organization" }, expected: ["studio-high", "studio-low"] },
    { query: { view: "organization_managed", endUserAccess: "unavailable", reportedUsage: "used" }, expected: ["admin-blocked"] },
    { query: { view: "all", endUserAccess: "unknown", management: "unknown" }, expected: ["native", "unknown"] },
    { query: { view: "all", management: "unknown", relevance: "unknown" }, expected: ["zero", "unknown"] },
    { query: { view: "availability_unknown", management: "unknown", relevance: "organization" }, expected: ["native"] },
    { query: { view: "unknown", reportedUsage: "used" }, expected: [] },
    { query: { view: "used", endUserAccess: "unavailable", management: "user_managed" }, expected: ["personal"] },
    { query: { view: "available", management: "user_managed" }, expected: [] },
    { query: { view: "unavailable", endUserAccess: "available" }, expected: [] },
    { query: { view: "organization", endUserAccess: "unavailable", reportedUsage: "used" }, expected: ["admin-blocked", "personal"] },
    { query: { view: "copilot_studio", reportedUsage: "used", management: "organization_managed", publisher: "Vendor", host: "Teams",
      platform: "Copilot Studio", blocked: false, source: "graph_packages", inventoryScope: "catalog" }, expected: ["studio-high", "studio-low"] },
    { query: { view: "copilot_studio", management: "unknown", search: "Generic" }, expected: ["generic"] },
    { query: { view: "organization_managed", search: "Generic" }, expected: [] },
    { query: { view: "copilot_studio", source: "power_platform" }, expected: [] },
  ] satisfies { query: InventoryQuery; expected: string[] }[])(
    "intersects independent quick-view criteria before counts, numeric paging and CSV: $query", async ({ query, expected }) => {
      const selected = await quick.select({ ...query, sortBy: "responses", sortDirection: "desc" }, 1);
      expect(selected.raw.counts).toMatchObject({ total: 10, scoped: query.inventoryScope === "catalog" ? 9 : 10, filtered: expected.length });
      const full = (await quick.select()).page!.value;
      const ordered = full.filter(record => expected.includes(identify(record))).sort((left, right) => {
        const a = left.usage!.responses, b = right.usage!.responses;
        if (a === null || b === null) return a === b ? -Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)) : a === null ? 1 : -1;
        return b - a || -Buffer.compare(Buffer.from(left.id), Buffer.from(right.id));
      });
      expect((await pages(quick, selected, 1)).map(identify)).toEqual(ordered.map(identify));
      const rows = (await csvRows(quick, selected)).filter(row => row.recordType === "agent");
      expect(rows).toHaveLength(expected.length);
      expect(rows.map(row => row.agentId)).toEqual((await pages(quick, selected, 1)).map(record => record.id));
    });

  it.each(unifiedAgentSortKeys.flatMap(sortBy => (["asc", "desc"] as const).map(sortDirection => ({ sortBy, sortDirection }))))(
    "matches displayed $sortBy values in $sortDirection first/middle/last/previous pages and CSV", async query => {
      const full = (await sortable.select()).page!.value.map(record => ({ ...record,
        packages: record.packages.map(item => allowlistedPackage(sortable.input.packages!.find(value => value.id === item.id)!)),
        powerPlatformResource: record.powerPlatformResource
          ? sortable.input.resources!.find(value => value.nativeId === record.powerPlatformResource!.nativeId)! : null,
      }));
      const environments = { [environmentA]: "Zebra environment", [environmentB]: "Alpha environment" };
      const compare = (left: UnifiedAgentRecord, right: UnifiedAgentRecord) => {
        const a = agentColumnValue(left, query.sortBy, environments), b = agentColumnValue(right, query.sortBy, environments);
        const tie = Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)) * (query.sortDirection === "desc" ? -1 : 1);
        if (a === null || b === null) return a === b ? tie : a === null ? 1 : -1;
        const value = typeof a === "number" && typeof b === "number" ? a - b
          : String(a).localeCompare(String(b), "en-US", { sensitivity: "base", numeric: query.sortBy === "versions" });
        return (query.sortDirection === "desc" ? -value : value) || tie;
      };
      const expected = [...full].sort(compare), selected = await sortable.select(query, 2);
      expect((await pages(sortable, selected)).map(record => record.id)).toEqual(expected.map(record => record.id));
      const rows = (await csvRows(sortable, selected)).filter(row => row.recordType === "agent");
      expect(rows.map(row => row.agentId)).toEqual(expected.map(record => record.id));
    });

  it("uses captured environment names and resolved people for exact filtering and source-preserving CSV", async () => {
    for (const search of ["Alpha Person", "alpha@example.invalid", ownerB, "Alpha environment"]) {
      const selected = await sortable.select({ search });
      expect(selected.page!.value.map(identify)).toEqual(["sort-native-b"]);
      const row = (await csvRows(sortable, selected)).find(row => row.recordType === "agent")!;
      expect(row).toMatchObject({ owner: ownerB, createdBy: ownerB, ownerDisplayName: "Alpha Person", createdByDisplayName: "Alpha Person" });
    }
    const selected = await sortable.select({ search: "no matching row", environmentId: environmentB });
    expect(selected.raw.counts.filtered).toBe(0);
    expect(await sortable.queries.facets(selected.selection.id, sortable.identity, "environmentId", { selected: true }))
      .toEqual({ value: [{ value: environmentB, label: "Alpha environment" }], total: 1, nextCursor: null });
  });

  it("uses exact canonical/package/native identity independently of page position without crossing the captured scope", async () => {
    const full = await scoped.select(), linked = full.page!.value.find(record => record.presence === "both")!;
    for (const recordId of [linked.id, unifiedAgentRecordId({ source: "graph_packages", packageId: "linked-a" }),
      unifiedAgentRecordId({ source: "graph_packages", packageId: "linked-b-blocked" }),
      unifiedAgentRecordId({ source: "power_platform", nativeId: "shared-native", environmentId: environmentA })]) {
      const raw = await scoped.queries.page(full.selection.id, scoped.identity, { recordId, limit: 1 });
      expect(inventoryPresentation(raw).value.map(record => record.id)).toEqual([linked.id]);
    }
    const native = full.page!.value.find(record => record.presence === "power_platform")!;
    expect((await scoped.select({ inventoryScope: "catalog", recordId: native.id })).raw.counts.filtered).toBe(0);
    const captured = await scoped.select({ inventoryScope: "catalog" });
    await expect(scoped.queries.page(captured.selection.id, { ...scoped.identity, principalId: "another-reader" })).rejects.toMatchObject({ code: "selection_invalidated" });
  });

  it.each(["typed_bot", "schema_native"])("keeps conflicting schemas separate before paging: %s", async matchKind => {
    const scenario = await seedSelectedInventory(database.runtime, {
      packages: ["cr_agent", "cr_other"].map((SchemaName, index) => ({
        ...packageValue(`conflict-${index}`), elementDetails: [{ elementType: "AgentMetadatas", elements: [{
          id: "metadata", definition: JSON.stringify({ SourceIds: { EnvironmentId: environmentA, CdsBotId: botA, SchemaName } }),
        }] }],
      })),
      resources: [matchKind === "typed_bot" ? resource(environmentA) : { ...resource(environmentA, botA), identifiers: [], details: { schemaName: "cr_agent" } }],
    });
    const selected = await scenario.select({}, 1);
    expect(selected.page!.summary).toMatchObject({ total: 3, linked: 0, graphOnly: 2, powerPlatformOnly: 1, conflicting: 2 });
    expect(await pages(scenario, selected, 1)).toHaveLength(3);
  });

  it.each(["stale", "invalidated"] as const)("does not authorize canonical matching with %s identity details", async state => {
    const value = packageValue("withdrawn", "Same displayed name", true);
    const scenario = await seedSelectedInventory(database.runtime, { packages: [{ ...value,
      detailFreshness: { state, observedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() - 1).toISOString() },
      ...(state === "invalidated" ? { identityRevalidationRequired: true } : {}) }], resources: [resource(environmentA)] });
    const selected = await scenario.select();
    expect(selected.page!.summary).toMatchObject({ total: 2, linked: 0, graphOnly: 1, powerPlatformOnly: 1 });
    expect(selected.page!.identityCollection).toMatchObject({ checkedPackages: 0, pendingPackages: 1 });
  });

  it.each(["full", "ai", "unknown"] as const)("uses proven agent-query coverage rather than the %s role hint", async roleScope => {
    const scenario = await seedSelectedInventory(database.runtime, { resources: [resource(environmentA)], roleScope,
      resourceTypes: ["microsoft.copilotstudio/agents"] });
    expect((await scenario.select()).page).toMatchObject({ partial: false, sources: { powerPlatform: { state: "available" } }, verification: { status: "verified" } });
  });

  it("keeps environment-only, unavailable and valid empty sources distinguishable", async () => {
    const partial = await seedSelectedInventory(database.runtime, { resources: [environment(environmentA, "Environment")],
      resourceTypes: ["microsoft.powerplatform/environments"] });
    expect((await partial.select()).page).toMatchObject({ partial: true, counts: { total: 0 }, sources: { powerPlatform: { state: "partial" } } });
    const missing = await seedSelectedInventory(database.runtime, { omitPackages: true, resources: [resource(environmentA)] });
    expect((await missing.select()).page).toMatchObject({ partial: true, counts: { total: 1 }, sources: { graphPackages: { state: "unavailable" } } });
    const empty = await seedSelectedInventory(database.runtime);
    expect((await empty.select()).page).toMatchObject({ partial: false, counts: { total: 0 }, verification: { status: "verified" } });
  });

  it("rejects invalid timestamps before source publication instead of accepting a false sort tie", async () => {
    await expect(seedSelectedInventory(database.runtime, { packages: [{ ...packageValue("invalid"), lastModifiedDateTime: "not-a-date" }] })).rejects.toThrow();
  });

  it("keeps legal maximum-width Unicode values and literal reserved names intact", async () => {
    const publisher = "界".repeat(4096);
    const scenario = await seedSelectedInventory(database.runtime, { packages: [
      { ...packageValue("__proto__", "Ａgent"), publisher }, { ...packageValue("constructor", "Agent"), publisher: "~null" },
      { ...packageValue("toString", "Ω"), publisher: "=untrusted" },
    ] });
    const selected = await scenario.select({ publisher });
    expect(selected.page!.value.map(identify)).toEqual(["__proto__"]);
    expect(Buffer.byteLength(JSON.stringify(selected.raw))).toBeLessThan(1024 * 1024);
    const exported = await scenario.select({ publisher: "=untrusted" });
    expect((await csvRows(scenario, exported)).find(row => row.recordType === "agent")!.publisher).toBe("'=untrusted");
    expect((await scenario.select({ publisher: "~null" })).page!.value.map(identify)).toEqual(["constructor"]);
  });
});
