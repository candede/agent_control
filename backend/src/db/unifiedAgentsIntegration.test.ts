import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse as parseCsv } from "csv-parse/sync";
import { parse as parseCsvStream } from "csv-parse";
import { pipeline } from "node:stream/promises";
import { testDatabase } from "../../scripts/testDatabase.js";
import {
  inventoryInput, inventorySelectionFixture, nativeInventoryFixture, reconcileInventoryFixture, streamedPackageFixture,
} from "../../scripts/inventoryFixtures.js";
import { allowlistedPackage } from "../services/packageObservation.js";
import { LargeTenantUsersReports } from "../services/largeTenantUsersReports.js";
import { OfficialAgentUsage } from "../services/officialAgentUsage.js";
import { inventoryPresentation } from "../services/inventoryPresentation.js";
import { DataExports } from "../services/dataExports.js";
import { inventoryExportColumns, inventoryExportSource, type InventoryExportKind } from "../services/inventoryExports.js";
import { PowerPlatformResourceQueryClient } from "../services/powerPlatformResourceQuery.js";
import { StreamedInventory } from "../services/streamedInventory.js";
import { GraphPackagesClient } from "../services/graphPackages.js";
import type { CopilotPackageDetail } from "../types/copilotPackage.js";
import type { PowerPlatformResource, PowerPlatformResourceType } from "../types/powerPlatformInventory.js";
import { deleteUsageSet, publishUsageReports, usageAudit, usageIdentity, usageIntent } from "./agentUsageTestSupport.js";
import { AgentPeopleRepository } from "./agentPeople.js";
import type { InventoryQuery } from "./inventoryQueries.js";
import { InventoryGenerations, inventorySelector } from "./inventoryGenerations.js";
import { LiveInventory } from "./liveInventory.js";
import { packageInventoryRecord } from "../services/inventoryRecordProjection.js";
import { checkpointQueries, observePeakMemory, observeQueryWork } from "../services/peakMemory.js";

type Scope = { tenantId: string; principalId: string };
const environmentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const manifestId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const botId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const unrelatedId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const agentType = "microsoft.copilotstudio/agents";
const environmentType = "microsoft.powerplatform/environments";
const newScope = (): Scope => ({ tenantId: `integration-${randomUUID()}`, principalId: randomUUID() });
let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => { fixture = await testDatabase(); });
afterAll(async () => { await fixture?.close(); });

function builderPackage(id: string, manifest = manifestId): CopilotPackageDetail {
  return allowlistedPackage({ id, displayName: " Shared agent ", isBlocked: id.endsWith("-blocked"), manifestId: manifest,
    platform: "Microsoft 365 Copilot Agent Builder", elementTypes: ["DeclarativeCopilots"], type: "external",
    availableTo: "allowedForAll", supportedHosts: ["Copilot", "Teams"],
    lastModifiedDateTime: "2026-09-24T08:00:00Z", version: "1",
    elementDetails: [{ elementType: "DeclarativeCopilots", elements: [{ id: "declarative", definition: "{}" }] }],
  });
}
function studioPackage(nativeId = botId, id = "studio-package") {
  return allowlistedPackage({ id, displayName: "Shared agent", isBlocked: false, platform: "Copilot Studio",
    elementDetails: [{ elementType: "AgentMetadatas", elements: [{ id: "identity", definition: JSON.stringify({
      SourceIds: { EnvironmentId: environmentId, CdsBotId: nativeId, SchemaName: "cr_studio" },
      AgentIdentityId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    }) }] }],
  });
}
function nativeResource(nativeId: string, schemaName = nativeId): Partial<PowerPlatformResource> & Pick<PowerPlatformResource, "nativeId" | "identifiers"> {
  return { nativeId, environmentId, displayName: "Shared agent", lifecycle: "published",
    identifiers: [{ kind: "environment_id", value: environmentId }, { kind: "power_platform_resource_id", value: nativeId }],
    details: { schemaName, isQuarantined: false } };
}
async function read(scope: Scope, query: InventoryQuery = {}) {
  const selected = await inventorySelectionFixture(fixture.runtime, scope, query);
  return { ...selected, page: inventoryPresentation(selected.raw) };
}
async function exportRows(selected: Awaited<ReturnType<typeof read>>, kind: InventoryExportKind = "unified_agents") {
  const exports = new DataExports(fixture.runtime, selected.queries.selections, async () => {});
  const id = await exports.create(selected.identity, { selectionId: selected.selection.id, queryHash: selected.selection.queryHash,
    kind, filename: "integration.csv" });
  await exports.build(id, selected.identity, inventoryExportColumns[kind], inventoryExportSource(selected.queries, selected.identity));
  let csv = "";
  for await (const chunk of exports.download(id, selected.identity, new AbortController().signal)) {
    expect(chunk.byteLength).toBeLessThanOrEqual(262_144);
    csv += chunk.toString();
    expect(Buffer.byteLength(csv)).toBeLessThan(1_048_576);
  }
  return parseCsv(csv, { columns: true, bom: true }) as Array<Record<string, string>>;
}
async function publishRaw(scope: Scope, count: number, raw: (index: number) => Record<string, unknown>,
  types: PowerPlatformResourceType[] = [agentType]) {
  const provider = new PowerPlatformResourceQueryClient(async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { Options: { SkipToken?: string } };
    const start = Number(request.Options.SkipToken ?? 0), size = Math.min(100, count - start);
    return Response.json({ totalRecords: count, count: size, resultTruncated: start + size < count,
      ...(start + size < count ? { skipToken: String(start + size) } : {}),
      data: Array.from({ length: size }, (_, index) => raw(start + index)),
    });
  });
  const stream = new StreamedInventory(fixture.runtime, undefined, provider), input = inventoryInput(scope.principalId, "power_platform");
  input.scope.tenantId = scope.tenantId;
  if (count > 100) input.reserveBytes = 64 * 1024 ** 2;
  input.scope.selector = inventorySelector({ domain: "power_platform", resourceTypes: types });
  return stream.powerPlatformCatalog(input, "synthetic", types, { roleScope: "full", authorize: async () => {} });
}

describe("typed unified inventory integration", () => {
  it("keeps a catalog-backed match through sparse detail enrichment and repeated catalog publication", async () => {
    const scope = newScope(), value = builderPackage("builder");
    await nativeInventoryFixture(fixture.runtime, scope, [nativeResource(manifestId), nativeResource(unrelatedId)]);
    await streamedPackageFixture(fixture.runtime, scope, [value]);
    await reconcileInventoryFixture(fixture.runtime, scope);
    const initial = await read(scope);
    expect(initial.page.summary).toMatchObject({ total: 2, linked: 1, graphOnly: 0, powerPlatformOnly: 1 });
    const canonicalId = initial.page.value.find(row => row.presence === "both")!.id;
    const { manifestId: _manifest, ...sparse } = value;
    const provider = new StreamedInventory(fixture.runtime, new GraphPackagesClient(async () => Response.json(sparse)));
    const input = inventoryInput(scope.principalId); input.scope.tenantId = scope.tenantId;
    await provider.details(input, "synthetic", [value.id], { authorize: async () => {} });
    await reconcileInventoryFixture(fixture.runtime, scope);
    const fresh = await read(scope);
    expect(fresh.page.value.find(row => row.id === canonicalId)?.packages[0].detailFreshness?.state).toBe("fresh");
    await streamedPackageFixture(fixture.runtime, scope, [value]);
    await reconcileInventoryFixture(fixture.runtime, scope);
    const refreshed = await read(scope);
    expect(refreshed.page.summary).toEqual(initial.page.summary);
    expect(refreshed.page.value.find(row => row.presence === "both")?.id).toBe(canonicalId);
    expect((await initial.queries.exact(initial.selection.id, initial.identity, [canonicalId.slice(6)]))).toHaveLength(1);
    expect((await exportRows(refreshed)).filter(row => row.recordType === "agent")).toHaveLength(2);
  });

  it("projects cached responsibility outside directory and report cohorts with pinned canonical navigation", async () => {
    const scope = newScope(), cache = new AgentPeopleRepository(fixture.runtime);
    const values = [
      { ...nativeResource(botId), createdBy: unrelatedId, details: { ownerId: manifestId, lastModifiedBy: manifestId } },
      { ...nativeResource(unrelatedId), details: { ownerId: manifestId } },
    ];
    await nativeInventoryFixture(fixture.runtime, scope, values);
    await streamedPackageFixture(fixture.runtime, scope, [studioPackage()], { exact: true });
    await reconcileInventoryFixture(fixture.runtime, scope);
    await cache.save(scope, [{ objectId: manifestId, status: "resolved", displayName: "Outside paid roster",
      userPrincipalName: "owner@example.invalid", checkedAt: new Date().toISOString() }], { generation: await cache.generation(scope) });
    const optional = await read(scope);
    expect((await optional.queries.responsibility(optional.selection.id, optional.identity, { objectId: manifestId }))
      .selected?.person.evidence).toBeNull();
    const selected = await read(scope, { sortBy: "owner" });
    const result = await selected.queries.responsibility(selected.selection.id, selected.identity, { objectId: manifestId, limit: 1 });
    expect(result.selected?.person.evidence?.displayName).toBe("Outside paid roster");
    expect(result.selected?.count).toBe(2);
    expect(result.selected?.agents).toHaveLength(1);
    expect(result.page.nextCursor).toEqual(expect.any(String));
    const next = await selected.queries.responsibility(selected.selection.id, selected.identity,
      { objectId: manifestId, limit: 1, cursor: result.page.nextCursor! });
    const ids = [...result.selected!.agents, ...next.selected!.agents].map(agent => agent.id);
    expect(new Set(ids).size).toBe(2);
    expect((await selected.queries.exact(selected.selection.id, selected.identity, ids.map(id => id.slice(6))))).toHaveLength(2);
    await expect(selected.queries.responsibility(selected.selection.id, { ...selected.identity, principalId: "different-reader" },
      { objectId: manifestId })).rejects.toMatchObject({ code: "selection_invalidated" });
    await cache.save(scope, [{ objectId: manifestId, status: "resolved", displayName: "Renamed outside paid roster",
      userPrincipalName: "owner@example.invalid", checkedAt: new Date().toISOString() }], { generation: await cache.generation(scope) });
    await expect(selected.queries.responsibility(selected.selection.id, selected.identity, { objectId: manifestId }))
      .rejects.toMatchObject({ code: "selection_invalidated", details: { reason: "changed" } });
    await nativeInventoryFixture(fixture.runtime, scope, values);
    await reconcileInventoryFixture(fixture.runtime, scope);
    const refreshed = await read(scope, { sortBy: "owner" });
    expect((await refreshed.queries.responsibility(refreshed.selection.id, refreshed.identity, { objectId: manifestId }))
      .selected?.agents.map(row => row.id).sort()).toEqual(ids.sort());
  });

  describe("responsibility beyond directory and report cohorts", () => {
    const scope = newScope(), creator = (index: number) => `10000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
    let selected: Awaited<ReturnType<typeof read>>;
    it("publishes all 301 real provider rows and their canonical responsibility evidence", async () => {
      await publishRaw(scope, 301, index => ({ tenantId: scope.tenantId, name: `agent-${index}`, type: agentType,
        properties: { environmentId, displayName: `Agent ${String(index).padStart(4, "0")}`, ownerId: manifestId, createdBy: creator(index) } }));
      await reconcileInventoryFixture(fixture.runtime, scope);
      selected = await read(scope);
      expect(selected.page.counts.total).toBe(301);
    });
    it("independently pages all 302 people with exact counts", async () => {
      const people = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await selected.queries.responsibility(selected.selection.id, selected.identity, { limit: 100, cursor });
        expect(page.counts).toEqual({ total: 302, filtered: 302 });
        expect(page.people.length).toBeLessThanOrEqual(100);
        for (const person of page.people) { expect(people.has(person.objectId)).toBe(false); people.add(person.objectId); }
        cursor = page.page.nextCursor ?? undefined;
      } while (cursor);
      expect(people.size).toBe(302);
    });
    it("independently pages all 301 owner relationships and exact final-creator navigation", async () => {
      const agents = new Set<string>();
      const milliseconds: number[] = [], bytes: number[] = [];
      let cursor: string | undefined;
      do {
        const started = performance.now();
        const page = await selected.queries.responsibility(selected.selection.id, selected.identity, { objectId: manifestId, limit: 100, cursor });
        milliseconds.push(performance.now() - started);
        bytes.push(Buffer.byteLength(JSON.stringify(page)));
        expect(milliseconds.at(-1)).toBeLessThan(15_000);
        expect(bytes.at(-1)).toBeLessThanOrEqual(524_288);
        expect(page.selected?.count).toBe(301);
        expect(page.selected!.agents.length).toBeLessThanOrEqual(100);
        for (const agent of page.selected!.agents) { expect(agents.has(agent.id)).toBe(false); agents.add(agent.id); }
        cursor = page.page.nextCursor ?? undefined;
      } while (cursor);
      expect(agents.size).toBe(301);
      const started = performance.now();
      expect((await selected.queries.responsibility(selected.selection.id, selected.identity, { objectId: creator(300), limit: 1 }))
        .selected?.count).toBe(1);
      milliseconds.push(performance.now() - started);
      expect(milliseconds.at(-1)).toBeLessThan(15_000);
      expect(milliseconds).toHaveLength(5);
      process.stdout.write(`RESPONSIBILITY_PAGE_RECEIPT ${JSON.stringify({ people: 302, relationships: agents.size,
        requests: milliseconds.length, milliseconds, maximumBytes: Math.max(...bytes) })}\n`);
    }, 30_000);
  });

  it("carries exact environments and configured operation children from the provider into durable exports", async () => {
    const scope = newScope(), creator = "52bff06b-5db5-42cd-9919-28f95e3c07af";
    const raw = [
      ...[botId, unrelatedId].map(name => ({ tenantId: scope.tenantId, name, type: agentType, location: "europe",
        properties: { environmentId, displayName: "Same agent name", ownerId: manifestId, createdBy: botId,
          powerPlatformConnectors: [{ connectorId: "shared_excelonlinebusiness", operations: [{
            operationId: "RunScriptProd", createdBy: creator, isEnabled: false, requiresEndUserConsent: false,
            usedAs: "Topic Tool", whenCanBeUsed: "ViaDirectReferenceOnly", connectionProvider: "Maker",
            connectionIdSharedByMaker: "secret-connection", callbackUrl: "https://private.invalid/?sig=secret",
          }] }], capabilitiesCounts: { distinctPowerPlatformConnectors: 3, distinctPowerPlatformConnectorsOperations: 5 },
          flowIds: [unrelatedId] },
      })),
      { tenantId: scope.tenantId, name: environmentId, type: environmentType, location: "europe",
        properties: { displayName: "Finance production", environmentType: "Production", isManaged: false, environmentGroup: "Finance" } },
    ];
    const root = await publishRaw(scope, raw.length, index => raw[index], [agentType, environmentType]);
    await streamedPackageFixture(fixture.runtime, scope, [studioPackage(manifestId, "unmatched-package")], { exact: true });
    await reconcileInventoryFixture(fixture.runtime, scope);
    const selected = await read(scope);
    expect(selected.page.value).toHaveLength(3);
    for (const row of selected.page.value) expect(row.environment).toMatchObject({
      id: environmentId, displayName: "Finance production", region: "europe", environmentType: "Production", isManaged: false,
      observation: { snapshotId: root.baselineId, current: true },
      provenance: { isManaged: { path: "properties.isManaged", maturity: "ga" } },
    });
    const native = selected.page.value.find(row => row.powerPlatformResource?.nativeId === botId)!;
    const members = await selected.queries.members(selected.selection.id, selected.identity, native.id.slice(6));
    const member = members.value.find(row => row.domain === "power_platform")!;
    expect(native.powerPlatformResource?.savedSource).toEqual({ scopeId: member.source_scope_id, identity: member.source_identity });
    const children = await selected.queries.children(selected.selection.id, selected.identity, native.id.slice(6),
      { kind: "connectorOperation", sourceScopeId: member.source_scope_id, sourceIdentity: member.source_identity });
    expect(children.total).toBe(1);
    expect(children.value[0].payload).toMatchObject({ operationId: "RunScriptProd", createdBy: creator, isEnabled: false, requiresEndUserConsent: false });
    const filtered = await selected.queries.children(selected.selection.id, selected.identity, native.id.slice(6),
      { kind: "connectorOperation", sourceScopeId: member.source_scope_id, sourceIdentity: member.source_identity, value: "0" });
    expect(filtered).toEqual(children);
    expect((await selected.queries.children(selected.selection.id, selected.identity, native.id.slice(6),
      { kind: "connectorOperation", sourceScopeId: member.source_scope_id, sourceIdentity: member.source_identity, value: "1" })).total).toBe(0);
    expect(JSON.stringify([selected.page, children])).not.toMatch(/secret-connection|private.invalid|flowIds/);
    const rows = await exportRows(selected), exported = rows.find(row => row.recordType === "agent" && row.agentId === native.id)!;
    expect(exported).toMatchObject({ environmentName: "Finance production", managedEnvironment: "false",
      environmentSnapshotId: root.baselineId, reportedConnectorTotal: "3", reportedOperationTotal: "5",
      savedConnectorDetails: "1", savedOperationDetails: "1", owner: manifestId, createdBy: botId });
    expect(rows.find(row => row.recordType === "child" && row.childKind === "connectorOperation")?.childData)
      .toContain("RunScriptProd");
    const renamed = await publishRaw(scope, 1, () => ({ ...raw[2], properties: { ...raw[2].properties, displayName: "Renamed environment" } }), [environmentType]);
    await reconcileInventoryFixture(fixture.runtime, scope);
    const updated = await read(scope);
    expect(updated.page.value.every(row => row.environment?.observation.snapshotId === renamed.baselineId)).toBe(true);
    expect((await selected.queries.page(selected.selection.id, selected.identity)).value).toEqual(selected.raw.value);
    expect((await exportRows(selected)).find(row => row.recordType === "agent")?.environmentName).toBe("Finance production");
  });

  it("projects reviewed usage with selected ordering, private inventory and report-change export fences", async () => {
    const scope = newScope(), usage = new OfficialAgentUsage(
      new LargeTenantUsersReports(fixture.runtime, "synthetic-fixture-selected-report-key", 35));
    await streamedPackageFixture(fixture.runtime, scope, ["used", "zero", "unlinked"].map((id, index) =>
      builderPackage(id, [manifestId, botId, unrelatedId][index])));
    await reconcileInventoryFixture(fixture.runtime, scope);
    await publishUsageReports(fixture.runtime, scope);
    const before = await read(scope);
    expect(before.page.value.every(row => row.usage?.status === "unlinked")).toBe(true);
    expect((await read(scope, { view: "organization" })).page.counts.filtered).toBe(0);
    for (const [id, report] of [["used", "Report-A"], ["zero", "Report-Zero"]]) {
      const selected = await read(scope), record = selected.page.value.find(row => row.packages[0].id === id)!;
      await usage.mutate(await usageIdentity(fixture.runtime, scope), record.id,
        await usageIntent(fixture.runtime, scope, report, { source: "graph_packages", packageId: id }), usageAudit(scope).actor);
    }
    const sorted = await read(scope, { sortBy: "responses", sortDirection: "desc" });
    expect(sorted.page.value.map(row => row.usage?.responses)).toEqual([10, 0, null]);
    expect(sorted.page.value.map(row => row.usage?.activeUsers)).toEqual([2, 0, null]);
    const first = await sorted.queries.page(sorted.selection.id, sorted.identity, { limit: 1 });
    const second = await sorted.queries.page(sorted.selection.id, sorted.identity, { limit: 1, cursor: first.page.nextCursor! });
    expect(inventoryPresentation(second).value[0].packages[0].id).toBe("zero");
    const filtered = await read(scope, { view: "used" });
    expect(filtered.page).toMatchObject({ counts: { total: 3, filtered: 1 }, summary: { total: 3 }, filteredSummary: { total: 1 } });
    expect((await exportRows(filtered)).filter(row => row.recordType === "agent")).toHaveLength(1);
    await expect(exportRows(before)).rejects.toMatchObject({ code: "selection_invalidated" });
    const other = { ...scope, principalId: "other-reader" };
    await streamedPackageFixture(fixture.runtime, other, [builderPackage("used")]);
    await reconcileInventoryFixture(fixture.runtime, other);
    const authorized = await read(other, { view: "used" });
    expect(authorized.page.value[0].usage).toMatchObject({ status: "linked", responses: 10, activeUsers: 2 });
    expect(authorized.page.value[0].id).not.toBe(filtered.page.value[0].id);
    const reviewed = await usageIntent(fixture.runtime, scope, "Report-A", { source: "graph_packages", packageId: "used" });
    const replacement = await publishUsageReports(fixture.runtime, scope, 11);
    expect((await read(scope, { view: "used" })).page.counts.filtered).toBe(0);
    expect((await exportRows(filtered)).filter(row => row.recordType === "agent")).toMatchObject([{ responses: "10" }]);
    await expect(usage.mutate(await usageIdentity(fixture.runtime, scope), filtered.page.value[0].id, reviewed, usageAudit(scope).actor))
      .rejects.toMatchObject({ code: "agent_usage_changed" });
    const replaced = await read(scope);
    await deleteUsageSet(fixture.runtime, scope, replacement.setId);
    expect((await read(scope)).page.usageContext).toMatchObject({ reports: { setId: null, availability: "not_selected" } });
    await expect(replaced.queries.page(replaced.selection.id, replaced.identity)).rejects.toMatchObject({ code: "selection_invalidated" });
  });

  it("keeps prior membership and read pins when an oversized later source record fails publication", async () => {
    const scope = newScope();
    await streamedPackageFixture(fixture.runtime, scope, [builderPackage("builder")]);
    await nativeInventoryFixture(fixture.runtime, scope, [nativeResource(manifestId)]);
    await reconcileInventoryFixture(fixture.runtime, scope);
    const before = await read(scope), input = inventoryInput(scope.principalId); input.scope.tenantId = scope.tenantId;
    const store = new InventoryGenerations(fixture.runtime);
    await expect(store.execute(input, { domain: "packages", mode: "baseline", channel: "catalog" }, async lease => {
      await store.append(lease, [packageInventoryRecord(allowlistedPackage({ id: "early", displayName: "Early", isBlocked: false }))]);
      await store.append(lease, [{ ...packageInventoryRecord(allowlistedPackage({ id: "late", displayName: "Late", isBlocked: false })),
        residual: { invalid: "x".repeat(262_145) } }]);
    }, { authorize: async () => {} })).rejects.toThrow();
    expect((await read(scope)).page.value.map(row => row.id)).toEqual(before.page.value.map(row => row.id));
    expect((await before.queries.page(before.selection.id, before.identity)).value).toEqual(before.raw.value);
    expect((await fixture.runtime.query(`SELECT count(*)::int AS count FROM inventory_roots root JOIN data_scope_epochs scope ON scope.id=root.scope_id
      JOIN inventory_memberships m ON m.baseline_id=root.baseline_id WHERE root.current AND root.domain='packages'
      AND scope.tenant_id=$1 AND scope.principal_id=$2 AND m.identity IN ('early','late')`, [scope.tenantId, scope.principalId])).rows[0].count).toBe(0);
  });

  it("withdraws identity proof off GET, splits safely and never authorizes removed native targets", async () => {
    const scope = newScope();
    await streamedPackageFixture(fixture.runtime, scope, [studioPackage()], { exact: true });
    await nativeInventoryFixture(fixture.runtime, scope, [nativeResource(botId, "cr_studio")]);
    await reconcileInventoryFixture(fixture.runtime, scope);
    const first = await read(scope);
    expect(first.page.summary.linked).toBe(1);
    await streamedPackageFixture(fixture.runtime, scope, [allowlistedPackage({ id: "studio-package", displayName: "Shared agent", isBlocked: false })], { exact: true });
    await reconcileInventoryFixture(fixture.runtime, scope);
    const split = await read(scope);
    expect(split.page.summary).toMatchObject({ linked: 0, graphOnly: 1, powerPlatformOnly: 1 });
    expect(new Set(split.page.value.map(row => row.id)).size).toBe(2);
    expect(split.page.value.filter(row => row.id === first.page.value[0].id)).toHaveLength(1);
    const native = split.page.value.find(row => row.presence === "power_platform")!;
    await nativeInventoryFixture(fixture.runtime, scope, [], { resourceTypes: [agentType] });
    await expect(new LiveInventory(fixture.runtime).record(scope, native.id)).rejects.toMatchObject({ code: "agent_not_found" });
    await reconcileInventoryFixture(fixture.runtime, scope);
    expect((await read(scope)).page.summary).toMatchObject({ graphOnly: 1, powerPlatformOnly: 0 });
  });

  describe("5000 logical agents from 10000 genuinely streamed source targets", () => {
    const scope = newScope(), total = 5000;
    let pipelineStarted = 0;
    const recordTiming = (stage: string, measurements: Record<string, number> = {}) => process.stdout.write(`${JSON.stringify({
      contract: "inventory-10000-sources", stage, elapsedMs: Math.round(performance.now() - pipelineStarted), ...measurements,
    })}\n`);
    const id = (index: number) => `10000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
    it("publishes every Graph provider page with production request pacing and bounded append", async () => {
    pipelineStarted = performance.now();
    const measured = new AsyncLocalStorage<boolean>(),queries = new Map<string,{ sql: string;count: number;milliseconds: number;maximumMs: number;rows: number }>();
    let fetches = 0,fetchMs = 0,unclassified = 0;
    const graph = new GraphPackagesClient(async url => {
      const started = performance.now();fetches++;
      const start = Number(new URL(String(url)).searchParams.get("page") ?? 0), count = Math.min(100, total - start);
      const next = new URL(String(url)); next.searchParams.set("page", String(start + count));
      const response = Response.json({ value: Array.from({ length: count }, (_, index) => builderPackage(`scale-${start + index}`, id(start + index))),
        "@odata.count": total, ...(start + count < total ? { "@odata.nextLink": next.toString() } : {}) });
      fetchMs += performance.now()-started;return response;
    });
    const input = inventoryInput(scope.principalId); input.scope.tenantId = scope.tenantId;
    input.reserveBytes = 64 * 1024 ** 2;
    observePeakMemory(() => {});
    observeQueryWork(value => {
      if (!measured.getStore()) return;
      const key = createHash("sha256").update(value.sql).digest("hex");
      const prior = queries.get(key);
      if (!prior && queries.size>=128) { unclassified++;return; }
      const row = prior ?? { sql: value.sql.slice(0,320),count: 0,milliseconds: 0,maximumMs: 0,rows: 0 };
      row.count++;row.milliseconds += value.milliseconds;row.maximumMs = Math.max(row.maximumMs,value.milliseconds);row.rows += value.rows;
      queries.set(key,row);
    });
    fixture.runtime.on("acquire",checkpointQueries);
    try {
      const graphRoot = await measured.run(true,() => new StreamedInventory(fixture.runtime, graph)
        .graphCatalog(input, "synthetic", { authorize: async () => {} }));
      expect((await fixture.runtime.query("SELECT batch_count FROM data_generations WHERE id=$1", [graphRoot.baselineId])).rows[0].batch_count).toBe(50);
      recordTiming("graph-published");
    } finally {
      fixture.runtime.removeListener("acquire",checkpointQueries);observeQueryWork();observePeakMemory();
      process.stdout.write(JSON.stringify({ contract: "inventory-graph-publication-cost",elapsedMs: performance.now()-pipelineStarted,
        fetches,fetchMs,unclassified,scope: "Only the Graph async context; overlapping SQL totals are not wall time.",
        queries: [...queries.values()].sort((a,b) => b.milliseconds-a.milliseconds) })+"\n");
    }
    }, 60_000);
    it("publishes every native provider page with production request pacing", async () => {
    await publishRaw(scope, total, index => ({ tenantId: scope.tenantId, name: id(index), type: agentType,
      properties: { environmentId, displayName: "Shared agent", schemaName: id(index) } }));
    recordTiming("native-published");
    }, 60_000);
    it("completes canonical publication for all 5000 exact pairs off GET", async () => {
    await reconcileInventoryFixture(fixture.runtime, scope, { reserveBytes: 64 * 1024 ** 2 });
    recordTiming("canonical-published");
    }, 60_000);
    it("selects exact logical counts and exports all source targets within each unchanged 15-second read/export assertion", async () => {
    const started = performance.now(), selected = await read(scope);
    const first = await selected.queries.page(selected.selection.id, selected.identity, { limit: 1 });
    expect(performance.now() - started).toBeLessThan(15_000);
    recordTiming("selected-first-page");
    expect(first.value).toHaveLength(1);
    expect(inventoryPresentation(first)).toMatchObject({ counts: { total }, partial: false,
      summary: { total, linked: total, graphOnly: 0, powerPlatformOnly: 0, ambiguous: 0, conflicting: 0 },
      identityCollection: { pendingPackages: total, checkedPackages: 0 },
      verification: { status: "details_pending", representedSourceCount: 10000, uniqueSourceCount: 10000, logicalAgentCount: total } });
    const exports = new DataExports(fixture.runtime, selected.queries.selections, async () => {}), exportStarted = performance.now(), deadline = Date.now() + 15_000;
    const exportId = await exports.create(selected.identity, { selectionId: selected.selection.id, queryHash: selected.selection.queryHash,
      kind: "unified_agents", filename: "large-inventory.csv" });
    const source = inventoryExportSource(selected.queries, selected.identity);
    let sourceReads = 0, sourceReadMs = 0;
    let slowest: { sql: string;parameters: unknown[];milliseconds: number } | undefined;
    const measured = new Map<string,{ calls: number;milliseconds: number;maximumMs: number;sql: string }>();
    observePeakMemory(() => {});
    observeQueryWork(value => {
      if (value.sql.startsWith("WITH report_binding") && value.parameters
        && value.milliseconds>(slowest?.milliseconds ?? 0)) {
        slowest = { sql: value.sql,parameters: value.parameters,milliseconds: value.milliseconds };
      }
      let item = measured.get(value.sql);
      if (!item && measured.size<128) {
        item = { calls: 0,milliseconds: 0,maximumMs: 0,sql: value.sql.slice(0,1024) }; measured.set(value.sql,item);
      }
      if (item) { item.calls++;item.milliseconds+=value.milliseconds;item.maximumMs=Math.max(item.maximumMs,value.milliseconds); }
    });
    try { await exports.build(exportId, selected.identity, inventoryExportColumns.unified_agents,
      (signal, job) => source(signal, { ...job, read: async work => {
        const started = performance.now();
        try { return await job.read(client => { checkpointQueries(client);return work(client); }); }
        finally { sourceReads++; sourceReadMs += performance.now() - started; }
      } })); }
    finally {
      observeQueryWork();observePeakMemory();
      process.stdout.write(JSON.stringify({ contract: "inventory-export-query-work",queries: [...measured.values()]
        .sort((a,b) => b.milliseconds-a.milliseconds).slice(0,10) })+"\n");
    }
    const buildMs = Math.round(performance.now() - exportStarted);
    try { expect(Date.now()).toBeLessThan(deadline); }
    finally {
      const metadata = (await fixture.runtime.query("SELECT row_count,byte_count,chunk_count FROM data_exports WHERE id=$1", [exportId])).rows[0];
      recordTiming("export-built", { buildMs, sourceReads, sourceReadMs: Math.round(sourceReadMs),
        rows: metadata.row_count, bytes: Number(metadata.byte_count), chunks: metadata.chunk_count });
      if (slowest) {
        const client = await fixture.runtime.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL jit=off; SET LOCAL enable_nestloop=on");
          const plan = (await client.query(`EXPLAIN(ANALYZE,BUFFERS,WAL,SETTINGS,FORMAT JSON) ${slowest.sql}`,slowest.parameters)).rows;
          process.stdout.write(JSON.stringify({ contract: "inventory-export-bounded-projection-plan",
            observedMaximumMs: slowest.milliseconds, plan })+"\n");
        } finally { await client.query("ROLLBACK");client.release(); }
      }
    }
    recordTiming("export-ready", { buildMs });
    expect(await exports.status(exportId, selected.identity)).toMatchObject({ status: "ready" });
    let agents = 0, sources = 0, rows = 0;
    await pipeline(exports.download(exportId, selected.identity, new AbortController().signal),
      async function* (chunks) {
        for await (const chunk of chunks) {
          expect(chunk.byteLength).toBeLessThanOrEqual(262_144);
          yield chunk;
        }
      }, parseCsvStream({ columns: true, bom: true }), async records => {
      for await (const row of records) {
        if (row.recordType === "agent") agents++;
        if (row.recordType === "source") sources++;
        rows++;
      }
    });
    expect(agents).toBe(total);
    expect(sources).toBe(10000);
    expect((await exports.status(exportId, selected.identity)).rows).toBe(rows);
    }, 60_000);
  });
});
