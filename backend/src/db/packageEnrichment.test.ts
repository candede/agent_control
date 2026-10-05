import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { inventorySelectionFixture, reconcileInventoryFixture } from "../../scripts/inventoryFixtures.js";
import { testDatabase } from "../../scripts/testDatabase.js";
import { allowlistedPackage } from "../services/packageObservation.js";
import { GraphPackagesClient } from "../services/graphPackages.js";
import { completeInventoryJob, inventoryJobInput } from "../services/inventoryRuntime.js";
import { inventoryPresentation } from "../services/inventoryPresentation.js";
import { StreamedInventory } from "../services/streamedInventory.js";
import type { CopilotPackageDetail } from "../types/copilotPackage.js";
import { PackageRefreshJobs, type PackageDataScope } from "./packageRefreshJobs.js";
import { verifySchema } from "./schema.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>, jobs: PackageRefreshJobs;
const selections: Awaited<ReturnType<typeof inventorySelectionFixture>>[] = [];
beforeAll(async () => { fixture = await testDatabase(); jobs = new PackageRefreshJobs(fixture.runtime); });
afterEach(async () => {
  for (const selected of selections.splice(0)) await selected.queries.selections.invalidate(selected.selection.id, selected.identity);
});
afterAll(async () => { await fixture?.close(); });
const scope = (): PackageDataScope => ({ tenantId: "detail-tenant", principalId: randomUUID() });
const summary = (id = "one", version = "1") => allowlistedPackage({
  id, displayName: `Catalog ${id}`, isBlocked: false, version, lastModifiedDateTime: "2026-09-24T08:00:00Z",
  manifestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", availableTo: "some", deployedTo: "none",
});
const detail = (id = "one", version = "1"): CopilotPackageDetail => ({
  ...summary(id, version), displayName: "Detail name", longDescription: "Saved detail description",
  allowedUsersAndGroups: [{ resourceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", resourceType: "user" }],
  elementDetails: [{ elementType: "DeclarativeCopilots", elements: [{ id: "element", definition: "{}" }] }],
});
type Job = NonNullable<Awaited<ReturnType<PackageRefreshJobs["getJob"]>>>;
async function collect(owner: PackageDataScope, job: Job, values: CopilotPackageDetail[], options: {
  beforeFetch?: () => Promise<void>; observedAt?: Date; failureId?: string;
} = {}) {
  if (values.length > 25) throw new Error("tiny_enrichment_provider_fixture_limit");
  const provider = new GraphPackagesClient(async url => {
    await options.beforeFetch?.();
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/packages")) return Response.json({ value: values, "@odata.count": values.length });
    const id = decodeURIComponent(path.split("/").at(-1)!);
    if (id === options.failureId) return Response.json({ error: { code: "unavailable" } }, { status: 503 });
    const value = values.find(item => item.id === id);
    return value ? Response.json(value) : Response.json({ error: { code: "notFound" } }, { status: 404 });
  }, { minimumReadIntervalMs: 0, maxAttempts: 1 });
  const input = await inventoryJobInput(fixture.runtime, owner, "packages", job.id);
  if (options.observedAt) input.observedAt = options.observedAt;
  const stream = new StreamedInventory(fixture.runtime, provider);
  const hooks = { authorize: async () => {}, completeJob: completeInventoryJob(input, "packages") };
  return job.scopeKind === "broad" ? stream.graphCatalog(input, "synthetic", hooks)
    : stream.exactJob(input, "synthetic", job.autoDetails, hooks);
}
async function publish(owner: PackageDataScope, values: CopilotPackageDetail[], requestedIds?: string[]) {
  const job = await jobs.submit(owner, { authorizationPrincipalId: owner.principalId, tokenMode: "delegated",
    idempotencyKey: randomUUID(), requestedIds });
  expect(await jobs.markRunning(owner, job.id)).toBe(true);
  return collect(owner, job, values);
}
async function claim(owner: PackageDataScope) {
  const job = await jobs.claimDueDetails(owner, owner.principalId);
  expect(job).not.toBeNull();
  expect(await jobs.markRunning(owner, job!.id, true)).toBe(true);
  return job!;
}
async function read(owner: PackageDataScope, id = "one") {
  const selected = await inventorySelectionFixture(fixture.runtime, owner, {}, "packages");
  selections.push(selected);
  return { ...selected, detail: await selected.queries.packageDetail(selected.selection.id, selected.identity, id),
    children: await selected.queries.children(selected.selection.id, selected.identity, id, { kind: "element", limit: 50 }) };
}
async function targetIds(owner: PackageDataScope, job: Job) {
  const selected = await inventorySelectionFixture(fixture.runtime, owner, {}, "packages");
  selections.push(selected);
  return (await jobs.targets(owner, selected.identity, job.id, { limit: 20 })).value.map(value => value.id);
}

describe("streamed catalog and bounded automatic detail enrichment", () => {
  it.each(["interaction_required", "missing_permission"])("backs off %s across the detail lane rather than trying another twenty targets", async code => {
    const owner = scope();
    await publish(owner, Array.from({ length: 25 }, (_, index) => summary(`auth-${index}`)));
    const first = await claim(owner);
    await jobs.markFailed(owner, first.id, code, "Authorization unavailable.");
    await fixture.operator.query("UPDATE package_refresh_jobs SET updated_at=clock_timestamp()-interval '1 minute' WHERE id=$1", [first.id]);
    expect(await jobs.claimDueDetails(owner, owner.principalId)).toBeNull();
    const signedInAt = Date.now(), retry = await jobs.claimDueDetails(owner, owner.principalId, signedInAt);
    if (code === "missing_permission") expect(retry).toBeNull();
    else {
      expect(retry).not.toBeNull();
      await jobs.markFailed(owner, retry!.id, code, "MFA is still required.");
      expect(await jobs.claimDueDetails(owner, owner.principalId, signedInAt)).toBeNull();
    }
  });
  it("uses restricted native target storage rather than a second package-detail cache", async () => {
    await verifySchema(fixture.runtime);
    expect((await fixture.runtime.query("SELECT to_regclass('package_detail_cache') AS obsolete")).rows[0].obsolete).toBeNull();
    await expect(fixture.runtime.query("TRUNCATE inventory_refresh_targets")).rejects.toThrow();
  });
  it("returns only retained authorized automatic detail history in every state", async () => {
    const owner = scope();
    expect(await jobs.latestAutomaticDetailsJob(owner, owner.principalId)).toBeNull();
    await publish(owner, [summary()]);
    expect(await jobs.latestAutomaticDetailsJob(owner, owner.principalId)).toBeNull();
    const automatic = (await jobs.claimDueDetails(owner, owner.principalId))!;
    expect(await jobs.latestAutomaticDetailsJob(owner, owner.principalId))
      .toMatchObject({ id: automatic.id, status: "waiting_authorization", autoDetails: true, targetCount: 1 });
    await jobs.markRunning(owner, automatic.id, true);
    expect(await jobs.latestAutomaticDetailsJob(owner, owner.principalId)).toMatchObject({ id: automatic.id, status: "running" });
    await jobs.markFailed(owner, automatic.id, "provider_error", "Retry later.");
    await publish(owner, [summary()]);
    expect(await jobs.latestAutomaticDetailsJob(owner, owner.principalId)).toMatchObject({ id: automatic.id, status: "failed" });
    expect(await jobs.latestAutomaticDetailsJob(owner, "other-reader")).toBeNull();
    expect(await jobs.latestAutomaticDetailsJob({ ...owner, principalId: "other-reader" }, owner.principalId)).toBeNull();
  });
  it("distinguishes unknown catalog identity from explicitly collected empty exact detail", async () => {
    const owner = scope();
    await publish(owner, [summary()]);
    expect((await read(owner)).detail).toMatchObject({ detailFreshness: { state: "missing", observedAt: null, expiresAt: null } });
    expect((await read(owner)).detail).not.toHaveProperty("identityDetailsCollected");
    await publish(owner, [summary()], ["one"]);
    const exact = await read(owner);
    expect(exact.detail).toMatchObject({ identityDetailsCollected: true, detailFreshness: { state: "fresh" } });
    expect(exact.children.total).toBe(0);
    expect(await jobs.claimDueDetails(owner, owner.principalId)).toBeNull();
  });
  it("deduplicates cross-instance claims under the database lock and exposes only a twenty-target page", async () => {
    const owner = scope();
    await publish(owner, Array.from({ length: 23 }, (_, index) => summary(`package-${index}`)));
    const other = new PackageRefreshJobs(fixture.runtime);
    const claims = (await Promise.all([jobs.claimDueDetails(owner, owner.principalId),
      other.claimDueDetails(owner, owner.principalId)])).filter((job): job is Job => job !== null);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ autoDetails: true, scopeKind: "exact", targetCount: 20 });
    expect(claims[0]).not.toHaveProperty("requestedIds");
    expect(await targetIds(owner, claims[0])).toHaveLength(20);
  });
  it("requires immutable per-target revision hashes for automatic work without exposing them as mutation authority", async () => {
    const owner = scope();
    await publish(owner, [summary()]);
    const automatic = (await jobs.claimDueDetails(owner, owner.principalId))!;
    const targets = (await fixture.runtime.query("SELECT catalog_revision_hash FROM inventory_refresh_targets WHERE job_id=$1", [automatic.id])).rows;
    expect(targets).toEqual([{ catalog_revision_hash: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    await expect(fixture.runtime.query(`UPDATE inventory_refresh_targets SET catalog_revision_hash=$2 WHERE job_id=$1`,
      [automatic.id, "a".repeat(64)])).rejects.toThrow("inventory_detail_target_revision_immutable");
    await expect(fixture.runtime.query("INSERT INTO inventory_refresh_targets(job_id,ordinal,target_id) VALUES($1,1,'unbound')",
      [automatic.id])).rejects.toMatchObject({ code: "23514" });
    expect(automatic).not.toHaveProperty("catalogRevisionHash");
  });
  it("does not reset provider backoff on an unchanged catalog but admits a changed revision and prioritizes it above stale evidence", async () => {
    const owner = scope();
    const initial = await jobs.submit(owner, { authorizationPrincipalId: owner.principalId, tokenMode: "delegated",
      idempotencyKey: randomUUID(), requestedIds: ["changed", "old"] });
    await jobs.markRunning(owner, initial.id);
    await collect(owner, initial, [detail("changed"), detail("old")], { observedAt: new Date(Date.now() - 3_601_000) });
    await publish(owner, [summary("changed", "2"), summary("old"), summary("new")]);
    const automatic = (await jobs.claimDueDetails(owner, owner.principalId))!;
    expect(await targetIds(owner, automatic)).toEqual(["changed", "new", "old"]);
    await jobs.markFailed(owner, automatic.id, "provider_error", "Unavailable.");
    await publish(owner, [{ ...summary("changed", "2"), displayName: "Only a name changed" }, summary("old"), summary("new")]);
    expect(await jobs.claimDueDetails(owner, owner.principalId)).toBeNull();
    await publish(owner, [summary("changed", "3"), summary("old"), summary("new")]);
    const changed = (await jobs.claimDueDetails(owner, owner.principalId))!;
    expect(await targetIds(owner, changed)).toEqual(["changed"]);
  });
  it.each([false, true])("enriches selected readers without replacing catalog or control state (sparse=%s)", async sparse => {
    const owner = scope(), catalog = await publish(owner, [{ ...summary(), isBlocked: true }]);
    const collected = detail();
    if (sparse) delete collected.manifestId;
    const job = await claim(owner);
    await collect(owner, job, [collected]);
    const detailed = await jobs.getJob(owner, job.id);
    const result = await read(owner);
    expect(result.detail).toMatchObject({ displayName: "Catalog one", isBlocked: true, longDescription: "Saved detail description",
      manifestId: summary().manifestId, identityDetailsCollected: true, detailFreshness: { state: "fresh" } });
    expect(result.children.total).toBe(1);
    expect(result.children.value[0].payload).toMatchObject({ id: "element", definition: "{}", elementType: "DeclarativeCopilots" });
    expect(result.raw.value[0].residual).not.toHaveProperty("elementDetails");
    await reconcileInventoryFixture(fixture.runtime, owner);
    const unified = await inventorySelectionFixture(fixture.runtime, owner);
    selections.push(unified);
    expect(inventoryPresentation(unified.raw).value[0].observations.packageSnapshots.one).toMatchObject({
      snapshotId: catalog.baselineId, identityDetails: { snapshotId: detailed!.snapshotId, current: true },
    });
    expect(await jobs.claimDueDetails(owner, owner.principalId)).toBeNull();
  });
  it("fences late details after newer catalog state, including remove/re-add with identical markers", async () => {
    const owner = scope();
    await publish(owner, [summary()]);
    const job = await claim(owner);
    await publish(owner, []);
    await publish(owner, [summary()]);
    await collect(owner, job, [detail()]);
    const result = await read(owner);
    expect(result.children.total).toBe(0);
    expect(result.detail).toMatchObject({ detailFreshness: { state: "missing" } });
    expect(result.detail).not.toHaveProperty("identityDetailsCollected", true);
  });
  it("retains compatible detail freshness across later catalog names while a changed revision becomes due immediately", async () => {
    const owner = scope();
    await publish(owner, [summary()]);
    await collect(owner, await claim(owner), [detail()]);
    const fresh = (await read(owner)).detail.detailFreshness;
    await publish(owner, [{ ...summary(), displayName: "Newest catalog", isBlocked: true }]);
    expect((await read(owner)).detail).toMatchObject({ displayName: "Newest catalog", isBlocked: true, detailFreshness: fresh });
    await publish(owner, [summary("one", "2"), summary("new")]);
    const changed = await jobs.claimDueDetails(owner, owner.principalId);
    expect(changed).not.toBeNull();
    expect(await targetIds(owner, changed!)).toEqual(["new", "one"]);
    expect((await read(owner)).detail.detailFreshness?.state).toBe("invalidated");
  });
  it("withdraws omitted exact identity children and preserves that explicit emptiness through a later catalog", async () => {
    const owner = scope();
    await publish(owner, [detail()], ["one"]);
    expect((await read(owner)).children.total).toBe(1);
    await publish(owner, [summary()], ["one"]);
    await publish(owner, [summary()]);
    const result = await read(owner);
    expect(result.children.total).toBe(0);
    expect(result.detail).toMatchObject({ identityDetailsCollected: true, detailFreshness: { state: "fresh" } });
  });
  it("publishes no partial detail stage after a provider failure and truthfully pages unpublished targets", async () => {
    const owner = scope();
    const root = await publish(owner, [summary("one"), summary("two")]);
    const automatic = await claim(owner);
    await expect(collect(owner, automatic, [detail("one"), detail("two")], { failureId: "two" })).rejects.toThrow();
    await jobs.markFailed(owner, automatic.id, "provider_error", "No complete detail stage was published.");
    const first = await read(owner);
    expect(first.detail.detailFreshness?.state).toBe("missing");
    expect((await read(owner, "two")).detail.detailFreshness?.state).toBe("missing");
    expect((await fixture.runtime.query("SELECT baseline_id,revision FROM inventory_roots WHERE scope_id=$1 AND current", [root.scopeId])).rows)
      .toEqual([{ baseline_id: root.baselineId, revision: root.revision }]);
    const page = await jobs.targets(owner, first.identity, automatic.id, { limit: 20 });
    expect(page.value).toMatchObject([{ id: "one", status: "observed_unpublished" }, { id: "two", status: "failed" }]);
    expect(await jobs.claimDueDetails(owner, owner.principalId)).toBeNull();
    await fixture.operator.query("UPDATE package_refresh_jobs SET updated_at=clock_timestamp()-interval '61 minutes' WHERE id=$1", [automatic.id]);
    const retry = await jobs.claimDueDetails(owner, owner.principalId);
    expect(retry).not.toBeNull();
    expect(await targetIds(owner, retry!)).toEqual(["one", "two"]);
  });
  it("does not invent success or remove catalog membership on an automatic detail 404", async () => {
    const owner = scope(), root = await publish(owner, [summary()]);
    const automatic = await claim(owner);
    await expect(collect(owner, automatic, [])).rejects.toMatchObject({ status: 404 });
    await jobs.markFailed(owner, automatic.id, "not_found", "The detail endpoint did not return the requested package.");
    expect((await read(owner)).detail).toMatchObject({ id: "one", detailFreshness: { state: "missing" } });
    expect((await fixture.runtime.query("SELECT revision FROM inventory_roots WHERE scope_id=$1 AND current", [root.scopeId])).rows[0].revision)
      .toBe(root.revision);
    expect(await jobs.latestAutomaticDetailsJob(owner, owner.principalId)).toMatchObject({ status: "failed", errorCode: "not_found" });
  });
  it("backs off interrupted expired work without resuming an unowned provider request", async () => {
    const owner = scope();
    await publish(owner, [summary()]);
    const automatic = await claim(owner);
    await jobs.recoverInterrupted();
    expect(await jobs.getJob(owner, automatic.id)).toMatchObject({ status: "running", autoDetails: true });
    await fixture.operator.query("UPDATE package_refresh_jobs SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1", [automatic.id]);
    expect(await jobs.claimDueDetails(owner, owner.principalId)).toBeNull();
    expect(await jobs.getJob(owner, automatic.id)).toMatchObject({ status: "failed", errorCode: "package_refresh_expired" });
  });
  it("invalidates old detail selections during clean resync and cannot reuse cleared identity", async () => {
    const owner = scope();
    await publish(owner, [summary()]);
    await collect(owner, await claim(owner), [detail()]);
    const pin = await read(owner);
    await fixture.runtime.query(`INSERT INTO data_sync_runs(id,tenant_id,principal_id,mode,source_ids,request_hash,clear_saved_data)
      VALUES($1,$2,$3,'full','["users","graph_packages","power_platform"]',$4,true)`,
    [randomUUID(), owner.tenantId, owner.principalId, "a".repeat(64)]);
    await expect(pin.queries.page(pin.selection.id, pin.identity)).rejects.toMatchObject({ code: "selection_invalidated" });
    await publish(owner, [summary()]);
    expect((await read(owner)).children.total).toBe(0);
  });
  it("persists one unambiguous broad/exact request shape and rejects a mismatched idempotent replay", async () => {
    const owner = scope(), input = { authorizationPrincipalId: owner.principalId, tokenMode: "delegated" as const, idempotencyKey: randomUUID() };
    const broad = await jobs.submit(owner, input);
    expect(broad).toMatchObject({ scopeKind: "broad", targetCount: 0 });
    expect(broad).not.toHaveProperty("catalogOnly");
    await expect(jobs.submit(owner, { ...input, requestedIds: ["one"] })).rejects.toMatchObject({ code: "idempotency_mismatch" });
  });
});
