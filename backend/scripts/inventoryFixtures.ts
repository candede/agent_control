import { randomUUID } from "node:crypto";
import { generationInput, selectionIdentity } from "./largeTenantFixtures.js";
import { packageInventoryRecord, powerPlatformInventoryRecord, type InventoryRecord } from "../src/services/inventoryRecordProjection.js";
import { InventoryGenerations, inventorySelector } from "../src/db/inventoryGenerations.js";
import type { GenerationLease } from "../src/db/dataGenerations.js";
import type pg from "pg";
import type { InventoryRoleScope, PowerPlatformResource, PowerPlatformResourceType } from "../src/types/powerPlatformInventory.js";
import { completeInventoryJob, inventoryJobInput, InventoryRuntime } from "../src/services/inventoryRuntime.js";
import { InventoryQueries, type InventoryQuery } from "../src/db/inventoryQueries.js";
import { DataGenerations } from "../src/db/dataGenerations.js";
import { StreamedInventory } from "../src/services/streamedInventory.js";
import { GraphPackagesClient } from "../src/services/graphPackages.js";
import type { CopilotPackageDetail } from "../src/types/copilotPackage.js";

export async function streamedPackageFixture(database: pg.Pool, scope: { tenantId: string; principalId: string },
  values: CopilotPackageDetail[], options: { exact?: boolean; tokenMode?: "delegated" | "application" } = {}) {
  if (values.length > 20) throw new Error("tiny_streamed_package_fixture_limit");
  const provider = new GraphPackagesClient(async url => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/packages")) return Response.json({ value: values, "@odata.count": values.length });
    const id = decodeURIComponent(path.split("/").at(-1)!);
    const value = values.find(record => record.id === id);
    return value ? Response.json(value) : Response.json({ error: { code: "notFound" } }, { status: 404 });
  }, { minimumReadIntervalMs: 0, maxAttempts: 1 });
  const stream = new StreamedInventory(database, provider);
  const input = async () => {
    const value = inventoryInput(scope.principalId);
    value.scope.tenantId = scope.tenantId;
    value.scope.tokenMode = options.tokenMode ?? "delegated";
    value.sessionEpoch = await stream.stages.generations.sessionEpoch(scope.tenantId, scope.principalId);
    return value;
  };
  let root = await stream.graphCatalog(await input(), "synthetic", { authorize: async () => {} });
  if (options.exact && values.length) root = await stream.exact(await input(), "synthetic", values.map(value => value.id), { authorize: async () => {} });
  return root;
}

export async function reconcileInventoryFixture(database: pg.Pool, scope: { tenantId: string; principalId: string },
  options: { reserveBytes?: number } = {}) {
  const runtime = new InventoryRuntime(database, async () => {});
  const input = inventoryInput(scope.principalId, "canonical");
  input.scope.tenantId = scope.tenantId;
  if (options.reserveBytes !== undefined) input.reserveBytes = options.reserveBytes;
  input.sessionEpoch = await new DataGenerations(database).sessionEpoch(scope.tenantId, scope.principalId);
  await runtime.publishControls(scope);
  await runtime.publishNativeControls(scope);
  if (await runtime.enqueue(scope)) return runtime.reconciliation.runNext(input, async () => {});
  return null;
}

export async function inventorySelectionFixture(database: pg.Pool, scope: { tenantId: string; principalId: string },
  query: InventoryQuery = {}, domain: "packages" | "power_platform" | "canonical" = "canonical") {
  const queries = new InventoryQueries(database, "synthetic-fixture-inventory-cursor-key-32");
  const identity = { ...selectionIdentity, ...scope,
    sessionEpoch: await new DataGenerations(database).sessionEpoch(scope.tenantId, scope.principalId) };
  const root = (await database.query(`SELECT r.scope_id FROM inventory_roots r JOIN data_scope_epochs s ON s.id=r.scope_id
    WHERE r.current AND s.tenant_id=$1 AND s.principal_id=$2 AND s.token_mode='delegated' AND r.domain=$3
    ORDER BY r.scope_id LIMIT 2`, [scope.tenantId, scope.principalId, domain])).rows;
  if (root.length !== 1) throw new Error("synthetic_selection_requires_one_source");
  const selection = await queries.capture(identity, root[0].scope_id, query);
  const raw = await queries.page(selection.id, identity, { limit: 50 });
  return { queries, identity, selection, raw };
}

export async function refreshInventoryFixture(database: pg.Pool, scope: { tenantId: string; principalId: string },
  jobId: string, domain: "packages" | "power_platform", records: InventoryRecord[],
  resourceTypes?: PowerPlatformResourceType[], options: { exactTargets?: string[]; expiresAt?: Date; roleScope?: InventoryRoleScope } = {}) {
  if (records.length > 100) throw new Error("tiny_refresh_fixture_limit");
  if (options.exactTargets && (domain !== "packages" || options.exactTargets.length > 100)) throw new Error("tiny_exact_fixture_limit");
  const input = await inventoryJobInput(database, scope, domain, jobId, { resourceTypes });
  if (options.expiresAt) input.expiresAt = options.expiresAt;
  const store = new InventoryGenerations(database);
  const root = await store.execute(input, { domain,
    ...(options.exactTargets ? { mode: "delta" as const, channel: "exact" as const, targets: options.exactTargets }
      : { mode: "baseline" as const, channel: "catalog" as const }),
    ...(domain === "power_platform" ? { resourceTypes, roleScope: options.roleScope ?? "full" } : {}) }, async lease => {
    if (!options.exactTargets) await store.visit(lease, "refresh-fixture");
    await store.appendBounded(lease, records);
    if (!options.exactTargets) await store.acceptPage(lease, { token: "refresh-fixture", nextToken: null, records, rawCount: records.length,
      expectedCount: records.length, page: 1 }, records.length);
  }, { authorize: async () => {}, completeJob: completeInventoryJob(input, domain) });
  const canonical = inventoryInput(scope.principalId, "canonical");
  canonical.scope.tenantId = scope.tenantId;
  canonical.sessionEpoch = input.sessionEpoch;
  const runtime = new InventoryRuntime(database, async () => {});
  if (await runtime.enqueue(scope)) await runtime.reconciliation.runNext(canonical, async () => {});
  return root;
}

export function inventoryInput(principalId: string = randomUUID(), source = "packages") {
  return generationInput({ scope: { tenantId: "synthetic-tenant", kind: "principal", principalId,
    tokenMode: "delegated", source: `inventory_${source}`, selector: "complete" } });
}
export function packageRecord(index: number, name = `Agent ${index}`) {
  return packageInventoryRecord({ id: `package-${index.toString().padStart(6, "0")}`, displayName: name, isBlocked: false } as Parameters<typeof packageInventoryRecord>[0]);
}
export async function nativeInventoryFixture(database: pg.Pool, scope: { tenantId: string; principalId: string },
  values: Array<Pick<PowerPlatformResource, "nativeId" | "identifiers"> & Partial<PowerPlatformResource>>,
  options: { observedAt?: Date; expiresAt?: Date; resourceTypes?: PowerPlatformResourceType[]; environmentId?: string } = {}) {
  if (values.length > 100) throw new Error("tiny_native_fixture_limit");
  const resources: PowerPlatformResource[] = values.map(value => ({
    type: "microsoft.copilotstudio/agents", environmentId: null, displayName: value.nativeId,
    sourceSystem: "power_platform", tenantId: scope.tenantId, location: null, createdAt: null, createdBy: null,
    creatorType: "unknown", agentKind: "copilot_studio_agent", lifecycle: "unknown", lastPublishedAt: null,
    authoringTool: null, identityConfidence: "exact_native", provenance: {}, details: {}, unknownFieldCount: 0, ...value,
  }));
  const input = inventoryInput(scope.principalId, "power_platform");
  input.scope.tenantId = scope.tenantId;
  input.sessionEpoch = await new DataGenerations(database).sessionEpoch(scope.tenantId, scope.principalId);
  if (options.observedAt) input.observedAt = options.observedAt;
  if (options.expiresAt) input.expiresAt = options.expiresAt;
  const intent = { domain: "power_platform" as const, mode: "baseline" as const, channel: "catalog" as const,
    resourceTypes: options.resourceTypes ?? [...new Set(resources.map(value => value.type))], roleScope: "full" as const,
    environmentId: options.environmentId };
  input.scope.selector = inventorySelector(intent);
  const store = new InventoryGenerations(database);
  return store.execute(input, intent, async lease => {
    const records = resources.map(powerPlatformInventoryRecord);
    await store.visit(lease, "native-fixture");
    await store.appendBounded(lease, records);
    await store.acceptPage(lease, { token: "native-fixture", nextToken: null, records, rawCount: records.length,
      expectedCount: records.length, page: 1 }, records.length);
  }, { authorize: async () => {} });
}
export async function inventoryBaseline(store: InventoryGenerations, principal: string, count: number, observedAt = new Date(), expiresAt?: Date) {
  return store.execute({ ...inventoryInput(principal), observedAt, ...expiresAt ? { expiresAt } : {} }, { domain: "packages", mode: "baseline", channel: "catalog" }, async lease => {
    let page = 0;
    for (let offset = 0; offset < count || offset === 0; offset += 100) {
      await store.visit(lease, `${offset}`);
      const records = Array.from({ length: Math.min(100, count - offset) }, (_, index) => packageRecord(offset + index));
      await store.appendBounded(lease, records);
      await store.acceptPage(lease, { token: `${offset}`, nextToken: offset + 100 < count ? `${offset + 100}` : null,
        records, rawCount: records.length, expectedCount: count, page: ++page }, records.length);
    }
  }, { authorize: async () => {} });
}
export async function inventoryDelta(store: InventoryGenerations, principal: string, count = 20,
  after?: (lease: GenerationLease) => Promise<void>) {
  return store.execute(inventoryInput(principal), { domain: "packages", mode: "delta", channel: "exact",
    targets: Array.from({ length: count }, (_, index) => packageRecord(index).native_id) }, async lease => {
    await store.appendBounded(lease, Array.from({ length: count }, (_, index) => packageRecord(index, `Changed ${index}`)));
    await after?.(lease);
  }, { authorize: async () => {} });
}
