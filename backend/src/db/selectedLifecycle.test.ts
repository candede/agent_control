import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "csv-parse/sync";
import { testDatabase } from "../../scripts/testDatabase.js";
import { generationInput, selectionIdentity, officialGoldenCsvRows } from "../../scripts/largeTenantFixtures.js";
import { inventoryInput, nativeInventoryFixture, reconcileInventoryFixture, streamedPackageFixture } from "../../scripts/inventoryFixtures.js";
import { InventoryQueries } from "./inventoryQueries.js";
import { DataGenerations } from "./dataGenerations.js";
import { UserSourceStages } from "./userSourceStages.js";
import { DataSyncRepository } from "./dataSync.js";
import { readAutomaticInventoryRevisions } from "./inventoryAutomaticRevisions.js";
import { OfficialReportImports } from "./officialReportImports.js";
import { schemaRegistry } from "../services/officialReportFields.js";
import { DataExports } from "../services/dataExports.js";
import { inventoryExportColumns, inventoryExportSource } from "../services/inventoryExports.js";
import { retainRecordData } from "./dataRetention.js";
import { InventoryGenerations } from "./inventoryGenerations.js";
import { AppError } from "../errors.js";
import type { SelectionIdentity } from "../services/dataSelections.js";

describe("selected saved-data lifecycle", () => {
  let fixture: Awaited<ReturnType<typeof testDatabase>>;
  let inventory: InventoryQueries;
  beforeAll(async () => {
    fixture = await testDatabase();
    inventory = new InventoryQueries(fixture.runtime, "synthetic-lifecycle-selected-read-secret");
  }, 30_000);
  afterAll(async () => { await fixture?.close(); });

  async function directory(identity: SelectionIdentity, objectId: string, name = "Zulu Owner") {
    const stages = new UserSourceStages(fixture.runtime);
    return stages.execute(generationInput({ scope: { ...generationInput().scope, tenantId: identity.tenantId,
      principalId: identity.principalId } }), async lease => {
      const key = await stages.query(lease, "discovery", "synthetic:lifecycle-directory");
      await stages.page(lease, key, "synthetic:lifecycle-directory", 1, 1);
      await stages.directory(lease, key, [{ serviceEvidenceVersion: 1,
        identity: { objectId, displayName: name, userPrincipalName: "owner@example.invalid", companyName: "Company",
          department: null, employeeType: null, accountEnabled: true, userType: "Member" },
        copilotServiceState: "disabled", servicePlans: [] }]);
      await stages.finishQuery(lease, key);
    }, { beforePublish: async () => {} });
  }
  async function subject() {
    const identity = { ...selectionIdentity, tenantId: randomUUID(), principalId: randomUUID() };
    const objectId = randomUUID(), environmentId = randomUUID();
    await directory(identity, objectId);
    const stages = new UserSourceStages(fixture.runtime);
    const activity = await stages.execute(generationInput({ scope: { ...generationInput().scope,
      tenantId: identity.tenantId, principalId: identity.principalId, source: "app_activity" } }), async lease => {
      const key = await stages.query(lease, "activity", "synthetic:lifecycle-activity");
      await stages.page(lease, key, "synthetic:lifecycle-activity", 0);
      await stages.finishQuery(lease, key);
    }, { beforePublish: async () => {} });
    await nativeInventoryFixture(fixture.runtime, identity, [
      { nativeId: "native-owned", displayName: "Native owned", identifiers: [], environmentId,
        createdBy: objectId, details: { ownerId: objectId } },
      { nativeId: environmentId, displayName: "Frozen Environment", identifiers: [],
        type: "microsoft.powerplatform/environments" },
    ]);
    await streamedPackageFixture(fixture.runtime, identity, [{ id: "agent-one", displayName: "Agent one", isBlocked: false }]);
    const root = (await reconcileInventoryFixture(fixture.runtime, identity))!;
    const imports = new OfficialReportImports(fixture.runtime), bundle = randomUUID(), rows = officialGoldenCsvRows();
    for (const kind of ["agents", "users", "userAgents"] as const) {
      async function* csv() { yield Buffer.from(`${schemaRegistry[kind].headers.join(",")}\n${rows[kind].join("\n")}\n`); }
      await imports.stage(identity, { bundleId: bundle }, csv());
    }
    await imports.acceptBundle(identity, bundle, await imports.bundle(identity, bundle));
    return { identity, objectId, environmentId, root, activity };
  }
  async function people(identity: SelectionIdentity, objectId: string, displayName = "Cached Owner") {
    await inventory.reports.sources.savePeople(identity, [{ objectId, status: "resolved", displayName,
      userPrincipalName: "owner@example.invalid", checkedAt: new Date().toISOString() }], async () => {});
  }
  const pins = async (id: string) => (await fixture.runtime.query(`SELECT s.source,p.root_kind FROM data_generation_pins p
    JOIN data_scope_epochs s ON s.id=p.scope_id WHERE p.selection_id=$1 ORDER BY s.source`, [id])).rows;

  it("keeps optional off-page cache age and activity independent, but bounds person-dependent reads", async () => {
    const { identity, objectId, root, activity } = await subject();
    const deadline = Date.now() + 3000;
    await inventory.reports.sources.savePeople(identity, [{ objectId: randomUUID(), status: "lookup_failed",
      displayName: null, userPrincipalName: null, checkedAt: new Date(deadline - 900_000).toISOString(),
      errorCode: "lookup_failed" }], async () => {});
    const selected = await inventory.capture(identity, root.scopeId);
    const guarded = await inventory.capture(identity, root.scopeId, { search: "Zulu Owner" });
    const empty = await inventory.capture(identity, root.scopeId, { publisher: "absent-publisher" });
    const report = await inventory.reports.capture(identity, "delegated", "copilot_users");
    const first = await inventory.page(selected.id, identity), facets = await inventory.facets(selected.id, identity, "environmentId");
    expect(selected.expiresAt.getTime() - selected.evaluatedAt.getTime()).toBe(600_000);
    expect(guarded.expiresAt.getTime()).toBe(deadline);
    expect((await pins(selected.id)).map(row => row.source)).not.toContain("user_sources");
    expect((await pins(selected.id)).map(row => row.source)).not.toContain("app_activity");
    expect((await pins(selected.id)).map(row => row.source)).toContain("directory");
    expect((await pins(report.id)).map(row => row.source)).toEqual(expect.arrayContaining(["directory", "app_activity"]));
    expect((await pins(report.id)).map(row => row.source)).not.toContain("user_sources");
    expect(first.value.some(row => row.responses === 9)).toBe(true);
    expect(first.value.find(row => row.people.owner)?.people.owner?.displayName).toBe("Zulu Owner");
    expect((await inventory.people(selected.id, identity, [objectId]))[0].displayName).toBe("Zulu Owner");
    const vector = await readAutomaticInventoryRevisions(identity, fixture.runtime);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, deadline - Date.now() + 25)));
    expect(await readAutomaticInventoryRevisions(identity, fixture.runtime)).toEqual(vector);
    const later = await inventory.page(selected.id, identity);
    expect(later.value).toEqual(first.value);
    expect(later.counts).toEqual(first.counts);
    expect(await inventory.facets(selected.id, identity, "environmentId")).toEqual(facets);
    expect((await inventory.page(empty.id, identity)).counts.filtered).toBe(0);
    expect(later.selection.evaluatedAt).toEqual(first.selection.evaluatedAt);
    expect(new Date(later.selection.validatedAt as Date).getTime()).toBeGreaterThan(new Date(first.selection.validatedAt as Date).getTime());
    await expect(inventory.page(guarded.id, identity)).rejects.toMatchObject({ code: "selection_invalidated", details: { reason: "expired" } });
    await new DataGenerations(fixture.runtime).invalidate(activity.scopeId, identity.tenantId);
    expect((await inventory.page(selected.id, identity)).value).toEqual(first.value);
    await expect(inventory.reports.page(report.id, identity)).rejects.toMatchObject({ details: { reason: "changed" } });
  }, 30_000);

  it("fences mutable person search and ordering while retaining immutable directory labels and environment queries", async () => {
    const { identity, objectId, root, environmentId } = await subject();
    await people(identity, objectId);
    const plain = await inventory.capture(identity, root.scopeId);
    const dependencies = await Promise.all([
      inventory.capture(identity, root.scopeId, { search: "Cached Owner" }),
      inventory.capture(identity, root.scopeId, { sortBy: "owner" }),
      inventory.capture(identity, root.scopeId, { sortBy: "createdBy" }),
    ]);
    const environment = await inventory.capture(identity, root.scopeId, { search: "Frozen Environment", sortBy: "environment" });
    expect((await inventory.page(environment.id, identity)).value.map(row => row.environmentId)).toEqual([environmentId]);
    const first = await inventory.page(plain.id, identity);
    await people(identity, objectId, "Changed cached name");
    for (const selected of [...dependencies, environment]) {
      await expect(inventory.page(selected.id, identity)).rejects.toMatchObject({ details: { reason: "changed" } });
    }
    expect((await inventory.page(plain.id, identity)).value).toEqual(first.value);
    await directory(identity, objectId, "New directory name");
    expect((await inventory.page(plain.id, identity)).value).toEqual(first.value);
    const current = await inventory.capture(identity, root.scopeId);
    expect((await inventory.page(current.id, identity)).value.find(row => row.people.owner)?.people.owner?.displayName).toBe("New directory name");
  }, 30_000);

  it("keeps report pages and child output immutable across people-cache changes", async () => {
    const { identity, objectId } = await subject();
    const selected = await inventory.reports.capture(identity, "delegated", "copilot_users");
    const first = await inventory.reports.page(selected.id, identity);
    const child = await inventory.reports.exact(selected.id, identity, objectId);
    await people(identity, objectId);
    expect((await inventory.reports.page(selected.id, identity)).value).toEqual(first.value);
    expect((await inventory.reports.exact(selected.id, identity, objectId)).value).toEqual(child.value);
    expect((await inventory.reports.page(selected.id, identity)).selection.publicationRevisions).toEqual(first.selection.publicationRevisions);
  }, 30_000);

  it("preserves frozen export labels across chunks and ordinary selection expiry, then rejects expired pins", async () => {
    const { identity, objectId, root } = await subject();
    const selected = await inventory.capture(identity, root.scopeId);
    const producer = new DataExports(fixture.runtime, inventory.selections, async () => {});
    const id = await producer.create(identity, { selectionId: selected.id, queryHash: selected.queryHash,
      kind: "unified_agents", filename: "synthetic-lifecycle.csv" });
    await fixture.operator.query(`UPDATE data_read_selections SET expires_at=evaluated_at+interval '1 millisecond' WHERE id=$1`, [selected.id]);
    const source = inventoryExportSource(inventory, identity);
    let batches = 0;
    await producer.build(id, identity, inventoryExportColumns.unified_agents, async function* (...args) {
      for await (const batch of source(...args)) {
        if (++batches === 1) {
          await people(identity, objectId, "Must not leak into the export");
          await directory(identity, objectId, "Must not replace exported directory");
        }
        yield batch;
      }
    });
    expect(batches).toBeGreaterThan(1);
    let csv = "";
    for await (const chunk of producer.download(id, identity, new AbortController().signal)) csv += chunk.toString();
    const rows = parse(csv, { columns: true, bom: true });
    expect(rows.filter((row: Record<string, string>) => row.ownerDisplayName).map((row: Record<string, string>) => row.ownerDisplayName))
      .toEqual(["Zulu Owner", "Zulu Owner"]);
    await expect(inventory.page(selected.id, identity)).rejects.toMatchObject({ details: { reason: "expired" } });
    await fixture.operator.query("UPDATE data_generation_pins SET expires_at=clock_timestamp()-interval '1 second' WHERE selection_id=$1", [selected.id]);
    await expect(producer.status(id, identity)).rejects.toMatchObject({ code: "selection_invalidated", details: { reason: "expired" } });
    await inventory.selections.connections.run(client => retainRecordData(client, 250));
    expect((await fixture.runtime.query("SELECT status FROM data_exports WHERE id=$1", [id])).rows[0].status).toBe("expired");
  }, 30_000);

  it("captures observer vectors atomically and distinguishes publication, progress and retirement", async () => {
    const { identity, objectId, root } = await subject();
    const sync = new DataSyncRepository(fixture.runtime);
    const before = await sync.automaticRevisions(identity);
    const selected = await inventory.capture(identity, root.scopeId);
    const page = await inventory.page(selected.id, identity);
    expect(page.selection.publicationRevisions).toEqual(before);
    await sync.submitDue(identity);
    expect(await sync.automaticRevisions(identity)).toEqual(before);
    const input = inventoryInput(identity.principalId);
    input.scope.tenantId = identity.tenantId;
    await expect(new InventoryGenerations(fixture.runtime).execute(input,
      { domain: "packages", mode: "baseline", channel: "catalog" },
      async () => { throw new AppError(504, "provider_timeout", "Synthetic provider timeout"); },
      { authorize: async () => {} })).rejects.toMatchObject({ status: 504 });
    expect(await sync.automaticRevisions(identity)).toEqual(before);
    expect((await inventory.page(selected.id, identity)).value).toEqual(page.value);
    await directory(identity, objectId, "Published replacement");
    const after = await sync.automaticRevisions(identity);
    expect(after.users).not.toBe(before.users);
    expect(after.power_platform).not.toBe(before.power_platform);
    expect((await inventory.page(selected.id, identity)).selection.publicationRevisions).toEqual(before);
    const newer = await inventory.capture(identity, root.scopeId);
    expect((await inventory.page(newer.id, identity)).selection.publicationRevisions).toEqual(after);
    const directoryScope = (await inventory.reports.page((await inventory.reports.capture(identity, "delegated", "copilot_users")).id, identity)).sources.directory.scopeId!;
    await new DataGenerations(fixture.runtime).invalidate(directoryScope, identity.tenantId);
    expect(await sync.automaticRevisions(identity)).not.toEqual(after);
    await expect(inventory.page(selected.id, identity)).rejects.toMatchObject({ details: { reason: "changed" } });
    await expect(inventory.page(selected.id, { ...identity, principalId: randomUUID() })).rejects.toMatchObject({ code: "selection_invalidated", details: undefined });
  }, 30_000);

  it("rejects missing context metadata without migrating or silently recapturing the selection", async () => {
    const { identity, root } = await subject();
    const selected = await inventory.capture(identity, root.scopeId);
    await fixture.operator.query("UPDATE inventory_read_contexts SET report_context=report_context-'publicationRevisions' WHERE selection_id=$1", [selected.id]);
    await expect(inventory.page(selected.id, identity)).rejects.toMatchObject({ code: "selection_invalidated", details: { reason: "unavailable" } });
    const report = await inventory.reports.capture(identity, "delegated", "history");
    await fixture.operator.query("UPDATE official_usage_read_contexts SET metadata=metadata-'publicationRevisions' WHERE selection_id=$1", [report.id]);
    await expect(inventory.reports.page(report.id, identity)).rejects.toMatchObject({ code: "selection_invalidated", details: { reason: "unavailable" } });
  }, 30_000);
});
