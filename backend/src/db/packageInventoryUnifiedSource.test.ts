import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { inventoryInput, inventorySelectionFixture, nativeInventoryFixture, reconcileInventoryFixture } from "../../scripts/inventoryFixtures.js";
import { allowlistedPackage } from "../services/packageObservation.js";
import { GraphPackagesClient } from "../services/graphPackages.js";
import { StreamedInventory } from "../services/streamedInventory.js";
import { inventoryPresentation } from "../services/inventoryPresentation.js";
import type { CopilotPackageDetail } from "../types/copilotPackage.js";
import { publishPackageReadback, readPackageInventoryGeneration } from "./packageControls.js";
import { dataConnections } from "./dataConnections.js";
import { LiveInventory } from "./liveInventory.js";
import { unifiedAgentRecordId } from "../types/unifiedAgents.js";
import type { InventoryQuery } from "./inventoryQueries.js";
import { InventoryGenerations } from "./inventoryGenerations.js";

let database: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => { database = await testDatabase(); });
afterAll(async () => { await database?.close(); });
const packageValue = (id: string, isBlocked = false) => allowlistedPackage({ id, displayName: id, isBlocked });

function provider() {
  const scope = { tenantId: "typed-package-observations", principalId: randomUUID() };
  let catalog: CopilotPackageDetail[] = [];
  const exact = new Map<string, CopilotPackageDetail>();
  const graph = new GraphPackagesClient(async url => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/packages")) return Response.json({ value: catalog, "@odata.count": catalog.length });
    const id = decodeURIComponent(path.split("/").at(-1)!);
    return exact.has(id) ? Response.json(exact.get(id)) : Response.json({ error: { code: "notFound" } }, { status: 404 });
  }, { minimumReadIntervalMs: 0, maxAttempts: 1 });
  const streamed = new StreamedInventory(database.runtime, graph);
  const input = () => {
    const value = inventoryInput(scope.principalId);
    value.scope.tenantId = scope.tenantId;
    return value;
  };
  return {
    scope, exact,
    async catalogPage(values: CopilotPackageDetail[]) {
      if (values.length > 20) throw new Error("tiny_provider_fixture_limit");
      catalog = values;
      const root = await streamed.graphCatalog(input(), "synthetic", { authorize: async () => {} });
      await reconcileInventoryFixture(database.runtime, scope);
      return root;
    },
    async exactPage(ids: string[], detailOnly = false, observedAt?: Date) {
      const generation = input();
      if (observedAt) generation.observedAt = observedAt;
      const root = await (detailOnly ? streamed.details : streamed.exact).call(streamed, generation, "synthetic", ids, { authorize: async () => {} });
      await reconcileInventoryFixture(database.runtime, scope);
      return root;
    },
    async read(query: InventoryQuery = {}) {
      const selected = await inventorySelectionFixture(database.runtime, scope, query);
      return { ...selected, page: inventoryPresentation(selected.raw) };
    },
  };
}

describe("typed package observation identity and provenance", () => {
  it("preserves immutable identity expiry through compaction and splits expired detail-only matches off GET", async () => {
    const source = provider(), environmentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", botId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await nativeInventoryFixture(database.runtime, source.scope, [{ nativeId: botId, environmentId,
      identifiers: [{ kind: "environment_id", value: environmentId }, { kind: "cds_bot_id", value: botId }] }]);
    source.exact.set("package", { ...packageValue("package"), version: "1",
      elementDetails: [{ elementType: "AgentMetadatas", elements: [{ id: "identity",
        definition: JSON.stringify({ SourceIds: { EnvironmentId: environmentId, CdsBotId: botId } }) }] }] });
    await source.exactPage(["package"], false, new Date(Date.now() - 3_600_000 + 2_500));
    const before = await source.read();
    expect(before.page.value).toHaveLength(1);
    expect(before.page.value[0].presence).toBe("both");
    const root = (await database.runtime.query(`SELECT r.scope_id AS "scopeId",r.tenant_id AS "tenantId",
      r.baseline_id AS "baselineId",r.revision,s.epoch FROM inventory_roots r JOIN data_scope_epochs s ON s.id=r.scope_id
      WHERE r.current AND r.domain='canonical' AND s.tenant_id=$1 AND s.principal_id=$2`,
    [source.scope.tenantId, source.scope.principalId])).rows[0];
    const expiry = (await database.runtime.query(`SELECT generation_id,identity,identity_expires_at FROM unified_agent_rows
      WHERE generation_id=$1`, [root.baselineId])).rows[0];
    expect(expiry.identity_expires_at).toBeInstanceOf(Date);
    await expect(database.operator.query(`UPDATE unified_agent_rows SET identity_expires_at=identity_expires_at+interval '1 hour'
      WHERE generation_id=$1 AND identity=$2`, [expiry.generation_id, expiry.identity])).rejects.toThrow("data_record_immutable");
    const input = inventoryInput(source.scope.principalId, "canonical");
    input.scope.tenantId = source.scope.tenantId;
    const compacted = await new InventoryGenerations(database.runtime).compact(input, root, { authorize: async () => {} });
    expect((await database.runtime.query(`SELECT r.generation_id,r.identity,r.identity_expires_at FROM inventory_memberships m
      JOIN unified_agent_rows r ON r.generation_id=m.generation_id AND r.identity=m.identity
      WHERE m.baseline_id=$1`, [compacted.baselineId])).rows).toEqual([expiry]);
    await expect.poll(() => Date.now() >= expiry.identity_expires_at.getTime(), { interval: 50, timeout: 3_000 }).toBe(true);
    await expect(new LiveInventory(database.runtime).record(source.scope, before.page.value[0].id)).rejects.toMatchObject({ code: "agent_not_found" });
    await reconcileInventoryFixture(database.runtime, source.scope);
    const after = await source.read();
    expect(after.page.counts.total).toBe(2);
    expect(after.page.summary).toMatchObject({ linked: 0, graphOnly: 1, powerPlatformOnly: 1 });
    expect(new Set(after.page.value.map(row => row.id)).size).toBe(2);
    expect(after.page.value.filter(row => row.id === before.page.value[0].id)).toHaveLength(1);
    expect(after.page.identityCollection?.pendingDetails.stale).toBe(1);
    expect((await before.queries.page(before.selection.id, before.identity)).counts.total).toBe(1);
  });
  it("reports time-expired detail evidence as stale in a new selection while retaining its provider catalog", async () => {
    const source = provider();
    source.exact.set("package", { ...packageValue("package"), version: "1",
      elementDetails: [{ elementType: "DeclarativeCopilots", elements: [{ id: "agent", definition: "{}" }] }] });
    await source.exactPage(["package"], false, new Date(Date.now() - 3600_000 + 2500));
    const before = await source.read();
    expect(before.page.identityCollection).toMatchObject({ checkedPackages: 1, pendingPackages: 0 });
    const revision = (await database.runtime.query(`SELECT revision FROM inventory_roots root JOIN data_scope_epochs scope ON scope.id=root.scope_id
      WHERE scope.tenant_id=$1 AND scope.principal_id=$2 AND scope.source='inventory_packages' AND root.current`,
    [source.scope.tenantId, source.scope.principalId])).rows[0].revision;
    const expiresAt = Date.parse(before.page.value[0].packages[0].detailFreshness!.expiresAt!);
    await expect.poll(() => Date.now() >= expiresAt, { interval: 100, timeout: 3500 }).toBe(true);
    const after = await source.read();
    expect(after.page.value).toHaveLength(1);
    expect(after.page.identityCollection).toMatchObject({ checkedPackages: 0, pendingPackages: 1, pendingDetails: { stale: 1 } });
    expect(after.page.value[0].packages[0]).toMatchObject({ detailFreshness: { state: "stale" } });
    expect(after.page.value[0].packages[0]).not.toHaveProperty("identityDetailsCollected", true);
    expect(after.page.freshness?.state).toBe("catching_up");
    const live = new LiveInventory(database.runtime);
    await expect(live.record(source.scope, before.page.value[0].id)).rejects.toMatchObject({ code: "agent_not_found" });
    expect((await before.queries.page(before.selection.id, before.identity)).verificationCounts.checked_packages).toBe(1);
    await reconcileInventoryFixture(database.runtime, source.scope);
    const reconciled = await source.read();
    expect(reconciled.page.value[0].id).toBe(before.page.value[0].id);
    expect(reconciled.page.freshness?.state).toBe("idle");
    await expect(live.record(source.scope, reconciled.page.value[0].id)).resolves.toMatchObject({ id: before.page.value[0].id });
    expect((await database.runtime.query(`SELECT revision FROM inventory_roots root JOIN data_scope_epochs scope ON scope.id=root.scope_id
      WHERE scope.tenant_id=$1 AND scope.principal_id=$2 AND scope.source='inventory_packages' AND root.current`,
    [source.scope.tenantId, source.scope.principalId])).rows[0].revision).toBe(revision);
    const generationCount = (await database.runtime.query("SELECT count(*)::int AS total FROM data_generations")).rows[0].total;
    await reconcileInventoryFixture(database.runtime, source.scope);
    expect((await database.runtime.query("SELECT count(*)::int AS total FROM data_generations")).rows[0].total).toBe(generationCount);
  });
  it("sorts by the displayed source observation rather than a common canonical reconciliation timestamp", async () => {
    const source = provider();
    await source.catalogPage([packageValue("older"), packageValue("newer")]);
    source.exact.set("newer", packageValue("newer"));
    await source.exactPage(["newer"]);
    for (const sortDirection of ["asc", "desc"] as const) {
      const { page } = await source.read({ sortBy: "observedAt", sortDirection });
      expect(page.value.map(record => record.packages[0].id)).toEqual(sortDirection === "asc" ? ["older", "newer"] : ["newer", "older"]);
      const times = page.value.map(record => Date.parse(record.observations.packageSnapshots[record.packages[0].id].observedAt));
      expect(times[0] === times[1]).toBe(false);
      expect(times[0] < times[1]).toBe(sortDirection === "asc");
      expect(page.value.map(record => record.columns!.observedAt)).toEqual(times);
    }
  });
  it.each(["__proto__", "constructor", "toString", "ordinary-id"])(
    "retains exact-only enumerable observation metadata for opaque ID %s", async id => {
      const source = provider();
      source.exact.set(id, packageValue(id));
      await source.exactPage([id]);
      const { page } = await source.read();
      expect(page.value).toHaveLength(1);
      expect(page.value[0].packages[0].id).toBe(id);
      const observations = page.value[0].observations.packageSnapshots;
      expect(Object.keys(observations)).toEqual([id]);
      expect(Object.hasOwn(observations, id)).toBe(true);
      expect(observations[id]).toMatchObject({ snapshotId: expect.any(String), scopeKind: "exact", current: true });
      expect(JSON.parse(JSON.stringify(observations))).toEqual(Object.fromEntries([[id, observations[id]]]));
      expect(Object.getPrototypeOf(observations)).toBe(Object.prototype);
    });

  it("preserves broad rows and their provenance while replacing exact targets and recording confirmed absences", async () => {
    const source = provider(), baseline = await source.catalogPage([packageValue("retained"), packageValue("__proto__"), packageValue("removed")]);
    source.exact.set("__proto__", packageValue("__proto__", true));
    await source.exactPage(["__proto__", "removed"]);
    const { page } = await source.read();
    expect(page.counts.total).toBe(2);
    const retained = page.value.find(row => row.packages[0].id === "retained")!;
    const replaced = page.value.find(row => row.packages[0].id === "__proto__")!;
    expect(retained.observations.packageSnapshots.retained).toMatchObject({ snapshotId: baseline.baselineId, scopeKind: "broad" });
    expect(replaced.packages[0].isBlocked).toBe(true);
    expect(replaced.observations.packageSnapshots["__proto__"]).toMatchObject({ scopeKind: "exact" });
    expect(replaced.observations.packageSnapshots["__proto__"].snapshotId).not.toBe(baseline.baselineId);
    expect(page.value.some(row => Object.hasOwn(row.observations.packageSnapshots, "removed"))).toBe(false);
  });

  it("retains compatible exact identity children, invalidates changed provider revisions and isolates application observations", async () => {
    const source = provider();
    const original = { ...packageValue("new"), lastModifiedDateTime: "2026-09-10T10:00:00.000Z", version: "1",
      appId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      elementDetails: [{ elementType: "AgentMetadatas", elements: [{ id: "metadata", definition: '{"fixture":"synthetic"}' }] }] };
    await source.catalogPage([packageValue("retain"), packageValue("delete")]);
    source.exact.set("new", original);
    await source.exactPage(["delete", "new"]);
    const application = inventoryInput(source.scope.principalId);
    application.scope.tenantId = source.scope.tenantId;
    application.scope.tokenMode = "application";
    const graph = new GraphPackagesClient(async () => Response.json({ value: [packageValue("application-only")], "@odata.count": 1 }),
      { minimumReadIntervalMs: 0, maxAttempts: 1 });
    await new StreamedInventory(database.runtime, graph).graphCatalog(application, "synthetic", { authorize: async () => {} });
    const readNew = async () => {
      const read = await source.read();
      expect(read.page.value.map(row => row.packages[0].id)).toEqual(["new", "retain"]);
      const detail = await read.queries.packageDetail(read.selection.id, read.identity, "new");
      const { recordId, sourceScopeId, sourceIdentity } = detail.selectedSource;
      const children = await read.queries.children(read.selection.id, read.identity, recordId,
        { sourceScopeId, sourceIdentity, kind: "element", limit: 50 });
      return { read, detail, children };
    };
    const { elementDetails: _details, ...catalog } = original;
    await source.catalogPage([packageValue("retain"), { ...catalog, isBlocked: true }]);
    const compatible = await readNew();
    expect(compatible.detail).toMatchObject({ isBlocked: true, identityDetailsCollected: true, detailFreshness: { state: "fresh" } });
    expect(compatible.children).toMatchObject({ total: 1, value: [{ payload: { elementType: "AgentMetadatas" } }] });
    expect(compatible.read.page.value[0].observations.packageSnapshots.new.scopeKind).toBe("broad");

    await source.catalogPage([packageValue("retain"), { ...catalog, isBlocked: false,
      lastModifiedDateTime: "2026-09-11T10:00:00.000Z", version: "2", appId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }]);
    const changed = await readNew();
    expect(changed.detail).toMatchObject({ detailFreshness: { state: "invalidated" } });
    expect(changed.detail).not.toHaveProperty("identityDetailsCollected", true);
    expect(changed.children).toMatchObject({ total: 0, value: [] });

    source.exact.set("new", { ...original, elementDetails: [] });
    await source.exactPage(["new"]);
    const empty = await readNew();
    expect(empty.detail).toMatchObject({ identityDetailsCollected: true, detailFreshness: { state: "fresh" } });
    expect(empty.children).toMatchObject({ total: 0, value: [] });
    expect(empty.read.page.value[0].observations.packageSnapshots.new.scopeKind).toBe("exact");
    source.exact.delete("new");
    await source.exactPage(["new"]);
    expect((await source.read()).page.value.map(row => row.packages[0].id)).toEqual(["retain"]);
  });

  it("removes a confirmed absent prototype-named target without inventing a row or an observation", async () => {
    const source = provider();
    await source.catalogPage([packageValue("__proto__")]);
    await source.exactPage(["__proto__"]);
    const { page } = await source.read();
    expect(page.value).toEqual([]);
    expect(page.counts.total).toBe(0);
  });

  it("rejects an exact provider response with a different opaque identity before publication", async () => {
    const source = provider();
    await source.catalogPage([packageValue("requested")]);
    const before = await source.read();
    source.exact.set("requested", packageValue("different"));
    await expect(source.exactPage(["requested"])).rejects.toMatchObject({ code: "target_mismatch" });
    const after = await source.read();
    expect(after.page.value).toEqual(before.page.value);
    expect(after.page.value[0].packages[0].id).toBe("requested");
  });

  it("does not promote catalog-only manifest fields to collected identity evidence", async () => {
    const source = provider();
    await source.catalogPage([{ ...packageValue("package"), manifestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      elementDetails: [{ elementType: "DeclarativeCopilots", elements: [{ id: "agent", definition: "{}" }] }] }]);
    const selected = await source.read();
    expect(selected.page.value[0].packages[0]).toMatchObject({ detailFreshness: { state: "missing" } });
    expect(selected.page.value[0].packages[0]).not.toHaveProperty("elementDetails");
    expect(selected.page.identityCollection?.checkedPackages).toBe(0);
    expect(selected.page.identityCollection?.pendingPackages).toBe(1);
    const detail = await selected.queries.packageDetail(selected.selection.id, selected.identity, "package");
    expect(detail).toMatchObject({ detailFreshness: { state: "missing" } });
    expect(detail).not.toHaveProperty("identityDetailsCollected", true);
  });

  it.each(["canonical", "source", "detail"] as const)("keeps control-only readbacks separate from identity collection in the %s reader", async reader => {
    const source = provider(), value = { ...packageValue("package"), manifestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      elementTypes: ["DeclarativeCopilots"],
      elementDetails: [{ elementType: "DeclarativeCopilots", elements: [{ id: "agent", definition: "{}" }] }] };
    await source.catalogPage([value]);
    await dataConnections(database.runtime).run(async client => {
      await publishPackageReadback(source.scope, { ...value, isBlocked: true }, client,
        await readPackageInventoryGeneration(source.scope, client), { kind: "block", isBlocked: true });
    });
    await reconcileInventoryFixture(database.runtime, source.scope);
    const selected = await source.read();
    const actual = reader === "canonical" ? selected.page.value[0].packages[0]
      : reader === "source" ? (await inventorySelectionFixture(database.runtime, source.scope, {}, "packages")).raw.value[0].residual
        : await selected.queries.packageDetail(selected.selection.id, selected.identity, value.id);
    expect(actual).toMatchObject({ id: value.id, isBlocked: true, detailFreshness: { state: "missing" } });
    expect(actual).not.toHaveProperty("identityDetailsCollected", true);
    expect(actual).not.toHaveProperty("elementDetails");
    expect(selected.page.identityCollection?.checkedPackages).toBe(0);
  });

  it("does not resurrect absent membership from a surviving verified control observation", async () => {
    const source = provider();
    await source.catalogPage([]);
    await dataConnections(database.runtime).run(async client => {
      await publishPackageReadback(source.scope, packageValue("absent", true), client,
        await readPackageInventoryGeneration(source.scope, client), { kind: "block", isBlocked: true });
    });
    await reconcileInventoryFixture(database.runtime, source.scope);
    expect((await source.read()).page.counts.total).toBe(0);
    await expect(new LiveInventory(database.runtime).record(source.scope, unifiedAgentRecordId({ source: "graph_packages", packageId: "absent" })))
      .rejects.toMatchObject({ code: "agent_not_found" });
  });

  it.each(["canonical", "source", "detail"].flatMap(reader =>
    ["identity", "access"].map(evidence => ({ reader, evidence })) ))(
    "preserves newer catalog $evidence evidence in selected $reader reads", async ({ reader, evidence }) => {
      const source = provider(), summary = { ...packageValue("package"), version: "1",
        lastModifiedDateTime: "2026-09-22T00:00:00Z", manifestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        availableTo: "some", deployedTo: "some" };
      await source.catalogPage([summary]);
      source.exact.set("package", { ...summary,
        allowedUsersAndGroups: [{ resourceId: "old-user", resourceType: "user" }],
        acquireUsersAndGroups: [{ resourceId: "old-group", resourceType: "group" }],
        elementDetails: [{ elementType: "DeclarativeCopilots", elements: [{ id: "agent", definition: "{}" }] }] });
      await source.exactPage(["package"], true);
      expect((await source.read()).page.identityCollection?.checkedPackages).toBe(1);
      await source.catalogPage([{ ...summary, ...(evidence === "identity"
        ? { elementDetails: [{ elementType: "AgentMetadatas", elements: [{ id: "metadata", definition: JSON.stringify({
          SourceIds: { EnvironmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
        }) }] }] } : { allowedUsersAndGroups: [], acquireUsersAndGroups: [] }) }]);
      const selected = await source.read();
      const detail = await selected.queries.packageDetail(selected.selection.id, selected.identity, summary.id);
      const value = reader === "canonical" ? selected.page.value[0].packages[0]
        : reader === "source" ? (await inventorySelectionFixture(database.runtime, source.scope, {}, "packages")).raw.value[0].residual : detail;
      if (evidence === "identity") {
        expect(value).toMatchObject({ detailFreshness: { state: "invalidated" }, identityRevalidationRequired: true });
        expect(value).not.toHaveProperty("identityDetailsCollected", true);
        expect(selected.page.identityCollection?.checkedPackages).toBe(0);
      } else {
        expect(value).toMatchObject({ detailFreshness: { state: "fresh" } });
        expect(detail).toMatchObject({ allowedUsersAndGroups: [], acquireUsersAndGroups: [] });
        expect(selected.page.identityCollection?.checkedPackages).toBe(1);
      }
      expect(value).not.toHaveProperty("elementDetails");
    });
});
