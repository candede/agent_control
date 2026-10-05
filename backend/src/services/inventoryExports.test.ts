import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { inventoryBaseline, inventoryInput, nativeInventoryFixture, reconcileInventoryFixture, streamedPackageFixture } from "../../scripts/inventoryFixtures.js";
import { parse as parseCsv } from "csv-parse/sync";
import { selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import { InventoryGenerations } from "../db/inventoryGenerations.js";
import { InventoryQueries } from "../db/inventoryQueries.js";
import { encodeBatch } from "../db/dataBounds.js";
import { InventoryReconciliation } from "./inventoryReconciliation.js";
import { DataExports } from "./dataExports.js";
import { inventoryExportColumns, inventoryExportSource, type InventoryExportKind } from "./inventoryExports.js";
import { allowlistedPackage } from "./packageObservation.js";

describe("durable selected inventory exports", () => {
  let fixture: Awaited<ReturnType<typeof testDatabase>>;
  let inventory: InventoryQueries;
  let exports: DataExports;
  beforeAll(async () => {
    fixture = await testDatabase();
    inventory = new InventoryQueries(fixture.runtime, "synthetic-inventory-export-cursor-key-32");
    exports = new DataExports(fixture.runtime, inventory.selections, async () => {});
  }, 30_000);
  afterAll(async () => { await fixture?.close(); });

  async function select(count: number, canonical: boolean) {
    const principalId = randomUUID(), identity = { ...selectionIdentity, principalId };
    const source = await inventoryBaseline(new InventoryGenerations(fixture.runtime), principalId, count);
    let root = source;
    if (canonical) {
      const reconcile = new InventoryReconciliation(fixture.runtime);
      const input = inventoryInput(principalId, "canonical");
      await reconcile.request(input, [source]);
      root = (await reconcile.runNext(input, async () => {}))!;
    }
    const selection = await inventory.capture(identity, root.scopeId);
    return { identity, selection };
  }

  it.each(["unified_agents", "power_platform_agents"] as const)(
    "rejects %s for an empty package source instead of inferring its kind from zero rows", async kind => {
      const { identity, selection } = await select(0, false);
      const id = await exports.create(identity, { selectionId: selection.id, queryHash: selection.queryHash,
        kind, filename: "synthetic.csv" });
      await expect(exports.build(id, identity, inventoryExportColumns[kind], inventoryExportSource(inventory, identity)))
        .rejects.toMatchObject({ code: "export_selection_kind" });
      expect(await exports.status(id, identity)).toMatchObject({ status: "failed" });
      expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM data_export_chunks WHERE export_id=$1", [id])).rows[0].count).toBe(0);
    },
  );

  it.each([
    { canonical: false, kind: "graph_packages" },
    { canonical: true, kind: "unified_agents" },
    { canonical: true, kind: "graph_packages" },
    { canonical: true, kind: "power_platform_agents" },
  ] as const)("publishes a truthful header-only $kind artifact from a valid empty selection (canonical=$canonical)", async ({ canonical, kind }) => {
    const { identity, selection } = await select(0, canonical);
    const id = await exports.create(identity, { selectionId: selection.id, queryHash: selection.queryHash,
      kind, filename: "synthetic.csv" });
    await exports.build(id, identity, inventoryExportColumns[kind], inventoryExportSource(inventory, identity));
    const status = await exports.status(id, identity);
    expect(status).toMatchObject({ status: "ready", rows: 0 });
    let bytes = 0;
    for await (const chunk of exports.download(id, identity, new AbortController().signal)) {
      bytes += chunk.byteLength;
      expect(chunk.toString()).toBe(`\uFEFF${inventoryExportColumns[kind].join(",")}\r\n`);
    }
    expect(bytes).toBe(status.bytes);
  });

  it("exports selected source pages with private ownership and no whole-source materialization", async () => {
    const { identity, selection } = await select(101, false);
    const kind: InventoryExportKind = "graph_packages";
    const id = await exports.create(identity, { selectionId: selection.id, queryHash: selection.queryHash,
      kind, filename: "synthetic.csv" });
    const source = inventoryExportSource(inventory, identity), batchSizes: number[] = [];
    await exports.build(id, identity, inventoryExportColumns[kind], async function* (...args) {
      for await (const batch of source(...args)) {
        batchSizes.push(batch.length);
        expect(encodeBatch(batch).bytes).toBeLessThanOrEqual(1_048_576);
        yield batch;
      }
    });
    expect(batchSizes).toEqual([100, 1]);
    expect(await exports.status(id, identity)).toMatchObject({ status: "ready", rows: 101 });
    await expect(exports.status(id, { ...identity, principalId: randomUUID() })).rejects.toThrow("export_not_found");
    const chunks = await fixture.runtime.query("SELECT max(byte_count)::integer AS maximum FROM data_export_chunks WHERE export_id=$1", [id]);
    expect(chunks.rows[0].maximum).toBeLessThanOrEqual(262_144);
    let lines = 0, pending = "";
    for await (const chunk of exports.download(id, identity, new AbortController().signal)) {
      pending += chunk.toString();
      const rows = pending.split("\r\n");
      pending = rows.pop()!;
      lines += rows.length;
    }
    expect(lines).toBe(102);
    expect(pending).toBe("");
  });

  it("seeks Graph source exports through a mixed canonical root without admitting native-only cursor rows", async () => {
    const identity = { ...selectionIdentity, principalId: randomUUID() };
    const scope = { tenantId: identity.tenantId, principalId: identity.principalId };
    await streamedPackageFixture(fixture.runtime, scope, ["B package", "D package", "F package"].map((displayName, index) =>
      allowlistedPackage({ id: `export-package-${index}`, displayName, isBlocked: false })));
    const native = {
      tenantId: identity.tenantId, type: "microsoft.copilotstudio/agents", environmentId: null, location: null,
      createdAt: null, createdBy: null, lastPublishedAt: null, sourceSystem: "power_platform" as const,
      authoringTool: "Copilot Studio", creatorType: "unknown" as const, agentKind: "copilot_studio_agent" as const,
      lifecycle: "draft" as const, identityConfidence: "exact_native" as const, identifiers: [], provenance: {}, unknownFieldCount: 0,
      details: { ownerId: null, lastModifiedBy: null, lastModifiedAt: null },
    };
    await nativeInventoryFixture(fixture.runtime, scope, ["A native", "C native", "E native"].map((displayName, index) => ({
      ...native, nativeId: `export-native-${index}`, displayName,
    })));
    const root = (await reconcileInventoryFixture(fixture.runtime, scope))!;
    const selected = await inventory.capture(identity, root.scopeId);
    let cursor: string | undefined;
    const names: string[] = [];
    do {
      const page = await inventory.page(selected.id, identity, { limit: 1, cursor, exportKind: "graph_packages" });
      expect(page.value).toHaveLength(1);
      names.push(page.value[0].displayName);
      cursor = page.page.nextCursor ?? undefined;
    } while (cursor);
    expect(names).toEqual(["B package", "D package", "F package"]);
  });

  it.each(["graph_packages", "unified_agents"] as const)("keeps private access assignments out of %s CSV child rows", async kind => {
    const identity = { ...selectionIdentity, principalId: randomUUID() };
    const scope = { tenantId: identity.tenantId, principalId: identity.principalId };
    let root = await streamedPackageFixture(fixture.runtime, scope, [allowlistedPackage({
      id: "exported-package", displayName: "Exported package", isBlocked: false, publisher: "=formula",
      allowedUsersAndGroups: [{ resourceId: "private-access-principal", resourceType: "user" }],
      acquireUsersAndGroups: [{ resourceId: "private-installation-principal", resourceType: "group" }],
    })]);
    if (kind === "unified_agents") root = (await reconcileInventoryFixture(fixture.runtime, scope))!;
    const selection = await inventory.capture(identity, root.scopeId);
    const id = await exports.create(identity, { selectionId: selection.id, queryHash: selection.queryHash,
      kind, filename: "private-safe.csv" });
    await exports.build(id, identity, inventoryExportColumns[kind], inventoryExportSource(inventory, identity));
    let csv = "";
    for await (const chunk of exports.download(id, identity, new AbortController().signal)) {
      csv += chunk.toString();
      expect(Buffer.byteLength(csv)).toBeLessThan(65_536);
    }
    expect(csv).toContain("Exported package");
    expect(csv).toContain("'=formula");
    expect(csv).not.toMatch(/private-access-principal|private-installation-principal|allowedUsersAndGroups|acquireUsersAndGroups/);
  });

  it.each(["power_platform_agents", "unified_agents"] as const)(
    "preserves exact saved counts and safe fields across 301 operation children in %s", async kind => {
      const identity = { ...selectionIdentity, principalId: randomUUID() };
      const scope = { tenantId: identity.tenantId, principalId: identity.principalId };
      let root = await nativeInventoryFixture(fixture.runtime, scope, [{
        tenantId: identity.tenantId, nativeId: "native", type: "microsoft.copilotstudio/agents",
        displayName: "=Formula agent", environmentId: null, location: null, createdAt: null, createdBy: null,
        lastPublishedAt: null, sourceSystem: "power_platform", authoringTool: "Copilot Studio", creatorType: "unknown",
        agentKind: "copilot_studio_agent", lifecycle: "draft", identityConfidence: "exact_native",
        identifiers: [], provenance: {}, unknownFieldCount: 0,
        details: { connectorDetailsStatus: "partial", distinctPowerPlatformConnectors: 4,
          distinctPowerPlatformConnectorsOperations: 999, connectors: [{ connectorId: "connector", operations:
            Array.from({ length: 301 }, (_, index) => ({ operationId: `operation-${index}`, isEnabled: false,
              requiresEndUserConsent: false, ...{ connectionIdSharedByMaker: "private-connection", callbackUrl: "https://private.invalid" } })) }] },
      }]);
      if (kind === "unified_agents") root = (await reconcileInventoryFixture(fixture.runtime, scope))!;
      const selection = await inventory.capture(identity, root.scopeId);
      const id = await exports.create(identity, { selectionId: selection.id, queryHash: selection.queryHash, kind, filename: "operations.csv" });
      await exports.build(id, identity, inventoryExportColumns[kind], inventoryExportSource(inventory, identity));
      let csv = "";
      for await (const chunk of exports.download(id, identity, new AbortController().signal)) {
        csv += chunk.toString();
        expect(Buffer.byteLength(csv)).toBeLessThan(1_048_576);
      }
      const rows = parseCsv(csv, { columns: true, bom: true }) as Array<Record<string, string>>;
      expect(rows.find(row => row.recordType === "source")).toMatchObject({
        displayName: "'=Formula agent", connectorDetailsStatus: "partial",
        reportedConnectorTotal: "4", reportedOperationTotal: "999", savedConnectorDetails: "1", savedOperationDetails: "301",
      });
      const operations = rows.filter(row => row.recordType === "child" && row.childKind === "connectorOperation");
      expect(operations).toHaveLength(301);
      expect(operations.map(row => JSON.parse(row.childData).payload)).toEqual(
        Array.from({ length: 301 }, (_, index) => ({ operationId: `operation-${index}`, isEnabled: false, requiresEndUserConsent: false })));
      expect(csv).not.toMatch(/private-connection|private.invalid|connectionIdSharedByMaker|callbackUrl/);
    });
});
