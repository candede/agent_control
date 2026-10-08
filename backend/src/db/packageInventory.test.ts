import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { retain } from "../../scripts/database.js";
import { inventorySelectionFixture, reconcileInventoryFixture } from "../../scripts/inventoryFixtures.js";
import { testDatabase } from "../../scripts/testDatabase.js";
import { allowlistedPackage } from "../services/packageObservation.js";
import { GraphPackagesClient } from "../services/graphPackages.js";
import { completeInventoryJob, inventoryJobInput } from "../services/inventoryRuntime.js";
import { StreamedInventory } from "../services/streamedInventory.js";
import type { CopilotPackageDetail } from "../types/copilotPackage.js";
import { PackageRefreshJobs, type PackageDataScope } from "./packageRefreshJobs.js";
import type { InventoryQuery } from "./inventoryQueries.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let jobs: PackageRefreshJobs;
const scope = { tenantId: "tenant-package", principalId: "reader-package" };
const selections: Awaited<ReturnType<typeof inventorySelectionFixture>>[] = [];
beforeAll(async () => { fixture = await testDatabase(); jobs = new PackageRefreshJobs(fixture.runtime); });
afterEach(async () => {
  for (const selected of selections.splice(0)) await selected.queries.selections.invalidate(selected.selection.id, selected.identity);
});
afterAll(async () => { await fixture?.close(); });

const packageValue = (id: string, blocked = false, overrides: Record<string, unknown> = {}) =>
  allowlistedPackage({ id, displayName: `Package ${id}`, isBlocked: blocked, supportedHosts: ["Copilot"],
    appId: `app-${id}`, manifestId: `manifest-${id}`, assetId: `asset-${id}`, ...overrides });
async function running(idempotencyKey: string, requestedIds?: string[], owner: PackageDataScope = scope) {
  const job = await jobs.submit(owner, { authorizationPrincipalId: owner.principalId,
    tokenMode: owner.tokenMode ?? "delegated", idempotencyKey, requestedIds });
  expect(await jobs.markRunning(owner, job.id)).toBe(true);
  return job.id;
}
async function refreshThroughProvider(owner: PackageDataScope, jobId: string, values: CopilotPackageDetail[],
  options: { targets?: string[]; pageSize?: number; expectedCount?: number; expiresAt?: Date; failContinuation?: boolean } = {}) {
  if (values.length > 100 || (options.targets?.length ?? 0) > 100) throw new Error("tiny_package_provider_fixture_limit");
  const pageSize = options.pageSize ?? 100;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error("tiny_package_provider_page_limit");
  const client = new GraphPackagesClient(async request => {
    const url = new URL(String(request));
    if (!url.pathname.endsWith("/packages")) {
      const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
      const value = values.find(item => item.id === id);
      return value ? Response.json(value) : Response.json({ error: { code: "notFound" } }, { status: 404 });
    }
    const offset = Number(url.searchParams.get("$skiptoken") ?? 0);
    if (offset && options.failContinuation) return Response.json({ error: { code: "ServiceUnavailable" } }, { status: 503 });
    const next = new URL(url);
    next.searchParams.set("$skiptoken", String(offset + pageSize));
    return Response.json({ value: values.slice(offset, offset + pageSize), "@odata.count": options.expectedCount ?? values.length,
      ...(offset + pageSize < values.length ? { "@odata.nextLink": next.href } : {}) });
  }, { minimumReadIntervalMs: 0, maxAttempts: 1 });
  const input = await inventoryJobInput(fixture.runtime, owner, "packages", jobId);
  if (options.expiresAt) input.expiresAt = options.expiresAt;
  const stream = new StreamedInventory(fixture.runtime, client);
  const hooks = { authorize: async () => {}, completeJob: completeInventoryJob(input, "packages") };
  const root = await (options.targets
    ? stream.exact(input, "synthetic", options.targets, hooks)
    : stream.graphCatalog(input, "synthetic", hooks));
  if (input.scope.tokenMode === "delegated") await reconcileInventoryFixture(fixture.runtime, owner);
  return root;
}
async function selected(query: InventoryQuery = {}, owner = scope) {
  const result = await inventorySelectionFixture(fixture.runtime, owner, query, "packages");
  selections.push(result);
  return result;
}

describe.sequential("streamed package inventory and durable refresh jobs", () => {
  it("gives admitted package work four hours and publishes beyond the old thirty-minute window", async () => {
    const owner = { tenantId: "tenant-long-package-refresh", principalId: "reader-long-package-refresh" };
    const job = await jobs.submit(owner, { authorizationPrincipalId: owner.principalId, tokenMode: "delegated", idempotencyKey: "long-refresh" });
    expect((await fixture.operator.query(`SELECT EXTRACT(EPOCH FROM (deadline_at-created_at))::double precision AS seconds
      FROM package_refresh_jobs WHERE id=$1`, [job.id])).rows[0].seconds).toBeCloseTo(4 * 60 * 60, 1);
    await fixture.operator.query(`UPDATE package_refresh_jobs SET created_at=clock_timestamp()-interval '2 hours',
      deadline_at=clock_timestamp()+interval '1 minute' WHERE id=$1`, [job.id]);
    expect(await jobs.markRunning(owner, job.id)).toBe(true);
    expect((await fixture.operator.query(`SELECT EXTRACT(EPOCH FROM (deadline_at-attempted_at))::double precision AS seconds
      FROM package_refresh_jobs WHERE id=$1`, [job.id])).rows[0].seconds).toBeCloseTo(4 * 60 * 60, 1);
    await fixture.operator.query(`UPDATE package_refresh_jobs SET attempted_at=clock_timestamp()-interval '1 hour',
      deadline_at=clock_timestamp()+interval '3 hours' WHERE id=$1`, [job.id]);
    await jobs.recordProgress(owner, job.id, 1, 1, 1, "Active long-running collection.");
    await refreshThroughProvider(owner, job.id, [packageValue("long-collected")]);
    expect(await jobs.getJob(owner, job.id)).toMatchObject({ status: "succeeded", observedCount: 1 });
  });

  it("does not let retained dispatch-expired jobs exhaust fresh admission", async () => {
    const owner = { tenantId: "tenant-package-deadline", principalId: "reader-package-deadline" };
    const input = { authorizationPrincipalId: owner.principalId, tokenMode: "delegated" as const };
    const expired = [];
    for (let index = 0; index < 5; index++) expired.push(await jobs.submit(owner, { ...input, idempotencyKey: `expired-${index}` }));
    await fixture.runtime.query(`UPDATE package_refresh_jobs SET deadline_at=clock_timestamp()-interval '1 second'
      WHERE tenant_id=$1 AND principal_id=$2`, [owner.tenantId, owner.principalId]);
    expect(await jobs.markRunning(owner, expired[0].id)).toBe(false);
    for (let index = 0; index < 5; index++) await expect(jobs.submit(owner, { ...input, idempotencyKey: `fresh-${index}` }))
      .resolves.toMatchObject({ status: "waiting_authorization" });
    await expect(jobs.submit(owner, { ...input, idempotencyKey: "fresh-over-limit" })).rejects.toMatchObject({ code: "job_limit" });
    expect(await jobs.getJob(owner, expired[0].id)).toBeDefined();
  });

  it("cancels only the requesting principal's unfinished read job", async () => {
    const job = await jobs.submit(scope, { authorizationPrincipalId: scope.principalId, tokenMode: "delegated", idempotencyKey: "package-cancel" });
    expect(await jobs.cancel({ ...scope, principalId: "other-reader" }, job.id, scope.principalId)).toBeUndefined();
    expect(await jobs.cancel(scope, job.id, "other-reader")).toMatchObject({ status: "waiting_authorization" });
    expect(await jobs.cancel(scope, job.id, scope.principalId)).toMatchObject({ status: "cancelled", errorCode: "cancelled" });
  });

  it("retains internal sync cleanup provenance instead of blaming the requesting principal", async () => {
    const job = await jobs.submit(scope, { authorizationPrincipalId: scope.principalId, tokenMode: "delegated", idempotencyKey: "package-cleanup" });
    await jobs.cancel(scope, job.id, scope.principalId, "sync_cleanup");
    await jobs.cancel(scope, job.id, scope.principalId);
    expect(await jobs.getJob(scope, job.id)).toMatchObject({
      status: "cancelled", errorCode: "data_sync_cleanup", message: expect.stringContaining("original failure or interruption"),
    });
  });

  it("atomically publishes complete provider pages and filters before counts and keysets", async () => {
    const id = await running("package-broad");
    await refreshThroughProvider(scope, id, [packageValue("b", true), packageValue("a")], { pageSize: 1 });
    expect(await jobs.getJob(scope, id)).toMatchObject({ status: "succeeded", observedCount: 2, pageCount: 2 });
    const read = await selected({ search: "Package", blocked: false });
    const page = await read.queries.page(read.selection.id, read.identity, { limit: 1 });
    expect(page.counts).toMatchObject({ total: 2, scoped: 2, filtered: 1 });
    expect(page.value.map(row => row.residual)).toMatchObject([{ id: "a", sourceSystem: "graph_packages" }]);
    expect(await read.queries.facets(read.selection.id, read.identity, "blocked"))
      .toMatchObject({ value: [{ value: "false" }, { value: "true" }], total: 2 });
    await expect(read.queries.page(read.selection.id, { ...read.identity, principalId: "other-reader" }))
      .rejects.toMatchObject({ code: "selection_invalidated" });
    const identifiers = await fixture.runtime.query(`SELECT count(*)::int AS total FROM inventory_facts
      WHERE generation_id=(SELECT id FROM data_generations WHERE job_id=$1 AND state='published') AND kind='search'`, [id]);
    expect(identifiers.rows[0].total).toBe(8);
  });

  it("retains broad membership and provenance while exact observations succeed or a later scan fails", async () => {
    await refreshThroughProvider(scope, await running("package-exact", ["c"]), [packageValue("c")], { targets: ["c"] });
    const before = await selected();
    expect(before.raw.value.map(row => row.id)).toEqual(["a", "b", "c"]);
    expect(await before.queries.packageDetail(before.selection.id, before.identity, "c"))
      .toMatchObject({ id: "c", observation: { current: true } });
    const failed = await running("package-failed");
    await jobs.recordProgress(scope, failed, 1, 1, 2);
    await jobs.markFailed(scope, failed, "provider_error", "The complete scan failed.");
    expect(await jobs.getJob(scope, failed)).toMatchObject({ status: "failed", pageCount: 1, observedCount: 1, totalRecords: 2 });
    expect((await selected()).raw.value).toEqual(before.raw.value);
  });

  it("resolves only bounded exact authorized targets and rejects a foreign principal", async () => {
    const read = await selected();
    expect((await read.queries.exact(read.selection.id, read.identity, ["c", "a", "missing"]))
      .map(row => ({ id: row.identity, package: row.residual }))).toMatchObject([
      { id: "a", package: { id: "a" } }, { id: "c", package: { id: "c" } },
    ]);
    await expect(read.queries.packageDetail(read.selection.id, read.identity, "missing"))
      .rejects.toMatchObject({ code: "inventory_record_not_found" });
    await expect(read.queries.exact(read.selection.id, { ...read.identity, principalId: "other-reader" }, ["a", "c"]))
      .rejects.toMatchObject({ code: "selection_invalidated" });
  });

  it("rejects incomplete, duplicate and out-of-scope publication without replacing the saved root", async () => {
    const before = (await selected()).raw;
    const incomplete = await running("package-incomplete");
    await expect(refreshThroughProvider(scope, incomplete, [packageValue("partial"), packageValue("unread")],
      { pageSize: 1, failContinuation: true })).rejects.toMatchObject({ status: 503 });
    await jobs.markFailed(scope, incomplete, "incomplete_coverage", "Synthetic partial provider response.");
    const duplicate = await running("package-duplicate");
    await expect(refreshThroughProvider(scope, duplicate, [packageValue("duplicate"), packageValue("duplicate")]))
      .rejects.toMatchObject({ code: "23505" });
    await jobs.markFailed(scope, duplicate, "duplicate_identity", "Synthetic duplicate provider response.");
    const exact = await running("package-wrong-target", ["expected"]);
    const graph = new GraphPackagesClient(async () => Response.json(packageValue("other")), { minimumReadIntervalMs: 0, maxAttempts: 1 });
    const input = await inventoryJobInput(fixture.runtime, scope, "packages", exact);
    await expect(new StreamedInventory(fixture.runtime, graph).exact(input, "synthetic", ["expected"], {
      authorize: async () => {}, completeJob: completeInventoryJob(input, "packages"),
    })).rejects.toMatchObject({ code: "target_mismatch" });
    await jobs.markFailed(scope, exact, "target_mismatch", "Synthetic wrong provider target.");
    expect((await selected()).raw.value).toEqual(before.value);
  });

  it("publishes the complete continuation chain rather than a provider count hint", async () => {
    const owner = { tenantId: "tenant-count-hint", principalId: "reader-count-hint" };
    const job = await running("catalog-count-hint", undefined, owner);
    await refreshThroughProvider(owner, job, [packageValue("hint-a"), packageValue("hint-b")], { pageSize: 1, expectedCount: 1 });
    expect(await jobs.getJob(owner, job)).toMatchObject({ status: "succeeded", observedCount: 2, totalRecords: 2, pageCount: 2 });
    expect((await selected({}, owner)).raw.value.map(row => row.id)).toEqual(["hint-a", "hint-b"]);
  });

  it("pages, filters, sorts, counts and facets beyond the first page without full-set reads", async () => {
    const values = Array.from({ length: 73 }, (_, index) => packageValue(`boundary-${String(index).padStart(3, "0")}`, index % 3 === 0, {
      publisher: index % 2 === 0 ? "Even publisher" : "Odd publisher", availableTo: index % 4 === 0 ? "some" : "none",
      supportedHosts: index % 5 === 0 ? ["Teams"] : ["Copilot"], platform: index % 7 === 0 ? "CopilotStudio" : "OtherPlatform",
      createdDateTime: index < 60 ? new Date().toISOString() : "2020-01-01T00:00:00.000Z",
    }));
    const job = await running("package-boundary");
    await refreshThroughProvider(scope, job, values, { pageSize: 50 });
    expect(await jobs.getJob(scope, job)).toMatchObject({ pageCount: 2, observedCount: 73 });
    const read = await selected({ publisher: "Even publisher", blocked: false, host: "Copilot", platform: "otherplatform",
      createdWithinDays: 1, sortBy: "displayName", sortDirection: "desc" });
    const first = await read.queries.page(read.selection.id, read.identity, { limit: 10 });
    expect(first.value).toHaveLength(10);
    expect(first.counts).toMatchObject({ total: 73, filtered: 13 });
    const second = await read.queries.page(read.selection.id, read.identity, { limit: 10, cursor: first.page.nextCursor! });
    expect(second.value).toHaveLength(3);
    expect(second.counts).toEqual(first.counts);
    expect(second.value[0].id > second.value.at(-1)!.id).toBe(true);
    expect((await read.queries.page(read.selection.id, read.identity, { limit: 10, cursor: second.page.previousCursor! })).value).toEqual(first.value);
    const unfiltered = await selected();
    expect((await unfiltered.queries.facets(unfiltered.selection.id, unfiltered.identity, "publisher")).value.map(row => row.value))
      .toEqual(["Even publisher", "Odd publisher"]);
  });

  it("retains saved source and success beyond freshness while expiring read leases and finite jobs", async () => {
    const owner = { tenantId: "tenant-package-retention", principalId: "reader-package-retention" };
    const job = await running("expiring-source", undefined, owner);
    await refreshThroughProvider(owner, job, [packageValue("expiring")], { expiresAt: new Date(Date.now() + 2500) });
    const read = await selected({}, owner);
    await expect(fixture.runtime.query("DELETE FROM package_inventory_snapshots WHERE tenant_id=$1", [owner.tenantId])).rejects.toThrow();
    await expect(fixture.runtime.query("DELETE FROM package_record_rows WHERE tenant_id=$1", [owner.tenantId])).rejects.toThrow();
    const success = (await jobs.listJobs(owner, owner.principalId)).lastSuccessAt;
    expect(success).not.toBeNull();
    await new Promise(resolve => setTimeout(resolve, 2550));
    expect((await read.queries.page(read.selection.id, read.identity)).counts.total).toBe(1);
    expect((await selected({}, owner)).raw.counts.total).toBe(1);
    expect((await jobs.listJobs(owner, owner.principalId)).lastSuccessAt).toBe(success);
    await fixture.operator.query("UPDATE data_read_selections SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [read.selection.id]);
    await expect(read.queries.page(read.selection.id, read.identity)).rejects.toMatchObject({ code: "selection_invalidated", details: { reason: "expired" } });
    await fixture.operator.query("UPDATE package_refresh_jobs SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [job]);
    await retain(fixture.operator);
    expect(await jobs.getJob(owner, job)).toBeUndefined();
    expect((await jobs.listJobs(owner, owner.principalId)).lastSuccessAt).toBe(success);
  });
});
