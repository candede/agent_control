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
import { retainRecordData } from "../db/dataRetention.js";
import { saveUsageInventory, usageIdentity } from "../db/agentUsageTestSupport.js";

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

  it("exports complete saved About chunks through the existing bounded source child rows", async () => {
    const scope = { tenantId: selectionIdentity.tenantId, principalId: randomUUID() };
    const text = {
      "about:long": "Complete long Ω🧭 ".repeat(2200),
      "about:short": "Complete short Ω🧭 ".repeat(1800),
      "about:native": "Complete native Ω🧭 ".repeat(1800),
    };
    await saveUsageInventory(fixture.runtime, scope, [{
      packages: ["about-export-package"],
      packageFields: { longDescription: text["about:long"], shortDescription: text["about:short"] },
      native: { nativeId: randomUUID(), environmentId: randomUUID(), description: text["about:native"] },
    }]);
    const identity = await usageIdentity(fixture.runtime, scope);
    const roots = await fixture.runtime.query<{ id: string }>(`SELECT id FROM data_scope_epochs
      WHERE tenant_id=$1 AND principal_id=$2 AND source='inventory_canonical'`, [scope.tenantId, scope.principalId]);
    expect(roots.rows).toHaveLength(1);
    const selection = await inventory.capture(identity, roots.rows[0].id, { inventoryScope: "all" });
    const kind = "unified_agents";
    const id = await exports.create(identity, { selectionId: selection.id, queryHash: selection.queryHash,
      kind, filename: "complete-about.csv" });
    await exports.build(id, identity, inventoryExportColumns[kind], inventoryExportSource(inventory, identity));
    const chunks: Buffer[] = [];
    for await (const chunk of exports.download(id, identity, new AbortController().signal)) chunks.push(chunk);
    const rows: Record<string, string>[] = parseCsv(Buffer.concat(chunks).toString("utf8"), { columns: true, bom: true });
    for (const [kind, expected] of Object.entries(text)) {
      const parts = rows.filter(row => row.recordType === "child" && row.childKind === kind);
      expect(parts.length).toBeGreaterThan(1);
      const actual = parts.map(row => {
        const child: unknown = JSON.parse(row.childData);
        if (!child || typeof child !== "object" || !("payload" in child) || !child.payload
          || typeof child.payload !== "object" || !("text" in child.payload) || typeof child.payload.text !== "string") {
          throw new Error("Saved About export must retain a typed text child.");
        }
        expect(row.sourceIdentity).toBeTruthy();
        expect(row.sourceGenerationId).toBeTruthy();
        return child.payload.text;
      }).join("");
      expect(actual).toBe(expected);
    }
    expect(await exports.status(id, identity)).toMatchObject({ status: "ready", rows: rows.length });
  });

  it.each(["queued", "ready"] as const)("revokes a %s artifact and collects its retained pins after reviewed associations change", async status => {
    const { identity, selection } = await select(1, true);
    const id = await exports.create(identity, { selectionId: selection.id, queryHash: selection.queryHash,
      kind: "unified_agents", filename: "revision.csv" });
    if (status === "ready") await exports.build(id, identity, inventoryExportColumns.unified_agents, inventoryExportSource(inventory, identity));
    await fixture.operator.query(`INSERT INTO agent_usage_state(tenant_id,revision) VALUES($1,1)
      ON CONFLICT(tenant_id) DO UPDATE SET revision=agent_usage_state.revision+1`, [identity.tenantId]);
    await expect(exports.status(id, identity)).rejects.toMatchObject({ code: "selection_invalidated" });
    await expect(exports.download(id, identity, new AbortController().signal).next()).rejects.toMatchObject({ code: "selection_invalidated" });
    expect(await exports.expire(id)).toBe(1);
    for (let slice = 0; slice < 16; slice++) await exports.connections.run(client => retainRecordData(client));
    expect((await fixture.runtime.query("SELECT ordinal FROM data_export_chunks WHERE export_id=$1", [id])).rows).toEqual([]);
    expect((await fixture.runtime.query("SELECT ordinal FROM data_generation_pins WHERE selection_id=$1", [selection.id])).rows).toEqual([]);
    expect((await fixture.runtime.query("SELECT status FROM data_exports WHERE id=$1", [id])).rows[0].status).toBe("expired");
  });

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
      tenantId: identity.tenantId, type: "microsoft.copilotstudio/agents" as const, environmentId: null, location: null,
      createdAt: null, createdBy: null, lastPublishedAt: null, sourceSystem: "power_platform" as const,
      authoringTool: "Copilot Studio", creatorType: "unknown" as const, agentKind: "copilot_studio_agent" as const,
      lifecycle: "draft" as const, identityConfidence: "exact_native" as const, identifiers: [], provenance: {}, unknownFieldCount: 0,
      details: {},
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

  it.each([false, true])("rejects a partially missing explicit Graph selection and emits only the exact valid ID (canonical=%s)", async canonical => {
    const { identity, selection } = await select(1, canonical);
    const ids = ["package-000000", "missing"];
    await expect(inventory.resolveExportReferences(selection.id, identity, ids, "graph_packages"))
      .rejects.toMatchObject({ code: "export_selection_changed" });
    const id = await exports.create(identity, { selectionId: selection.id, queryHash: selection.queryHash,
      kind: "graph_packages", filename: "explicit.csv", ids });
    await expect(exports.build(id, identity, inventoryExportColumns.graph_packages, inventoryExportSource(inventory, identity)))
      .rejects.toMatchObject({ code: "export_selection_changed" });
    expect(await exports.status(id, identity)).toMatchObject({ status: "failed", error: "export_selection_changed" });
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM data_export_chunks WHERE export_id=$1", [id])).rows[0].count).toBe(0);
    await expect(exports.download(id, identity, new AbortController().signal).next()).rejects.toThrow("export_not_ready");
    const exact = await inventory.resolveExportReferences(selection.id, identity, [ids[0]], "graph_packages");
    const valid = await exports.create(identity, { selectionId: selection.id, queryHash: selection.queryHash,
      kind: "graph_packages", filename: "exact.csv", ids: exact });
    await exports.build(valid, identity, inventoryExportColumns.graph_packages, inventoryExportSource(inventory, identity));
    let csv = "";
    for await (const chunk of exports.download(valid, identity, new AbortController().signal)) csv += chunk.toString();
    expect((parseCsv(csv, { bom: true, columns: true }) as Array<Record<string, string>>).map(row => row.id)).toEqual([ids[0]]);
  });

  it.each([false, true])("rejects a raw native ID that names two environments (canonical=%s)", async canonical => {
    const identity = { ...selectionIdentity, principalId: randomUUID() };
    const scope = { tenantId: identity.tenantId, principalId: identity.principalId };
    let root = await nativeInventoryFixture(fixture.runtime, scope,
      [randomUUID(), randomUUID()].map(environmentId => ({ nativeId: "repeated-native-id", environmentId, identifiers: [] })));
    if (canonical) root = (await reconcileInventoryFixture(fixture.runtime, scope))!;
    const selection = await inventory.capture(identity, root.scopeId);
    await expect(inventory.resolveExportReferences(selection.id, identity, ["repeated-native-id"], "power_platform_agents"))
      .rejects.toMatchObject({ code: "export_selection_changed" });
    const id = await exports.create(identity, { selectionId: selection.id, queryHash: selection.queryHash,
      kind: "power_platform_agents", filename: "ambiguous.csv", ids: ["repeated-native-id"] });
    await expect(exports.build(id, identity, inventoryExportColumns.power_platform_agents, inventoryExportSource(inventory, identity)))
      .rejects.toMatchObject({ code: "export_selection_changed" });
    expect(await exports.status(id, identity)).toMatchObject({ status: "failed", error: "export_selection_changed" });
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM data_export_chunks WHERE export_id=$1", [id])).rows[0].count).toBe(0);
  });

  it.each(["graph_packages", "unified_agents"] as const)("keeps private access and sharing assignments out of %s CSV child rows", async kind => {
    const identity = { ...selectionIdentity, principalId: randomUUID() };
    const scope = { tenantId: identity.tenantId, principalId: identity.principalId };
    let root = await streamedPackageFixture(fixture.runtime, scope, [allowlistedPackage({
      id: "exported-package", displayName: "Exported package", isBlocked: false, publisher: "=formula",
      allowedUsersAndGroups: [{ resourceId: "private-access-principal", resourceType: "user" }],
      acquireUsersAndGroups: [{ resourceId: "private-installation-principal", resourceType: "group" }],
      sharedWithUsersAndGroups: [{ resourceId: "private-sharing-principal", resourceType: "User" }],
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
    expect(csv).not.toMatch(/private-access-principal|private-installation-principal|private-sharing-principal|allowedUsersAndGroups|acquireUsersAndGroups|sharedWithUsersAndGroups/);
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
