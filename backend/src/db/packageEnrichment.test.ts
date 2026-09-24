import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { grantRuntime } from "../../scripts/database.js";
import { allowlistedPackage } from "../services/packageObservation.js";
import type { CopilotPackageDetail } from "../types/copilotPackage.js";
import { packageEnrichmentMigrationSql, verifyPackageEnrichmentSchema } from "./packageEnrichmentSchema.js";
import { PackageInventoryRepository, type PackageDataScope } from "./packageInventory.js";
import { migrations } from "./schema.js";
import { readUnifiedInventoryRevision } from "./unifiedInventoryRevision.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let repository: PackageInventoryRepository;
beforeAll(async () => {
  fixture = await testDatabase();
  if (!migrations.some(step => String(step.sql) === packageEnrichmentMigrationSql)) {
    await fixture.operator.query(packageEnrichmentMigrationSql);
    await grantRuntime(fixture.operator);
  }
  repository = new PackageInventoryRepository(fixture.runtime);
});
afterAll(async () => { await fixture?.close(); });
const scope = (): PackageDataScope => ({ tenantId: "detail-tenant", principalId: randomUUID() });
function summary(id = "one", version = "1") {
  return allowlistedPackage({
    id, displayName: `Catalog ${id}`, isBlocked: false, version,
    lastModifiedDateTime: "2026-09-24T08:00:00Z", manifestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    availableTo: "some", deployedTo: "none",
  });
}
function detail(id = "one", version = "1"): CopilotPackageDetail {
  return {
    ...summary(id, version), displayName: "Detail name", longDescription: "Saved detail description", identityDetailsCollected: true,
    allowedUsersAndGroups: [{ resourceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", resourceType: "user" }],
    elementDetails: [{ elementType: "DeclarativeCopilots", elements: [{ id: "element", definition: "{}" }] }],
  };
}
async function publish(owner: PackageDataScope, values: CopilotPackageDetail[], catalogOnly = true, requestedIds?: string[]) {
  const job = await repository.submit(owner, {
    authorizationPrincipalId: owner.principalId, tokenMode: "delegated", idempotencyKey: randomUUID(), catalogOnly, requestedIds,
  });
  await repository.markRunning(owner, job.id);
  return repository.publish(owner, job.id, { packages: values, totalRecords: values.length, pages: 1 });
}
async function enrich(owner: PackageDataScope, values: CopilotPackageDetail[]) {
  const job = (await repository.claimDueDetails(owner, owner.principalId))!;
  expect(job).not.toBeNull();
  await repository.markRunning(owner, job.id, true);
  await repository.publish(owner, job.id, { packages: values, totalRecords: values.length, pages: 1, detailFailures: [] });
  return job;
}

describe("persisted catalog and automatic detail enrichment", () => {
  it.each(["interaction_required", "missing_permission"])(
    "backs off %s across the whole detail lane, not just the failed twenty targets", async code => {
      const owner = scope();
      await publish(owner, Array.from({ length: 25 }, (_, index) => summary(`auth-${index}`)));
      const first = (await repository.claimDueDetails(owner, owner.principalId))!;
      await repository.markFailed(owner, first.id, code, "Authorization unavailable.");
      await fixture.operator.query(`UPDATE package_refresh_jobs SET updated_at=clock_timestamp()-interval '1 minute'
        WHERE id=$1`, [first.id]);
      expect(await repository.claimDueDetails(owner, owner.principalId)).toBeNull();
      const signedInAt = Date.now();
      const retry = await repository.claimDueDetails(owner, owner.principalId, signedInAt);
      if (code === "missing_permission") {
        expect(retry).toBeNull();
      } else {
        expect(retry).not.toBeNull();
        await repository.markFailed(owner, retry!.id, code, "MFA is still required.");
        expect(await repository.claimDueDetails(owner, owner.principalId, signedInAt)).toBeNull();
      }
    },
  );

  it("verifies migration contracts and grants for the restricted runtime", async () => {
    await expect(verifyPackageEnrichmentSchema(fixture.runtime)).resolves.toBeUndefined();
    await expect(fixture.runtime.query("TRUNCATE package_detail_cache")).rejects.toThrow();
  });

  it("returns only the latest retained, authorized automatic detail history in every state", async () => {
    const owner = scope();
    expect(await repository.latestAutomaticDetailsJob(owner, owner.principalId)).toBeNull();
    await publish(owner, [summary()]);
    expect(await repository.latestAutomaticDetailsJob(owner, owner.principalId)).toBeNull();
    const automatic = (await repository.claimDueDetails(owner, owner.principalId))!;
    expect(await repository.latestAutomaticDetailsJob(owner, owner.principalId)).toMatchObject({
      id: automatic.id, status: "waiting_authorization", autoDetails: true,
    });
    await repository.markRunning(owner, automatic.id, true);
    expect(await repository.latestAutomaticDetailsJob(owner, owner.principalId)).toMatchObject({ id: automatic.id, status: "running" });
    await repository.markFailed(owner, automatic.id, "provider_error", "Retry later.");
    await publish(owner, [summary()]);
    expect(await repository.latestAutomaticDetailsJob(owner, owner.principalId)).toMatchObject({
      id: automatic.id, status: "failed", errorCode: "provider_error",
    });
    expect(await repository.latestAutomaticDetailsJob(owner, "other-reader")).toBeNull();
    expect(await repository.latestAutomaticDetailsJob({ ...owner, principalId: "other-reader" }, owner.principalId)).toBeNull();
  });

  it("distinguishes unknown broad data from explicitly collected empty and legacy exact detail proof", async () => {
    const unknown = scope();
    await publish(unknown, [summary()], false);
    const value = (await repository.get(unknown, "one"))!.package!;
    expect(value).not.toHaveProperty("identityDetailsCollected");
    expect(value.detailFreshness).toEqual({ state: "missing", observedAt: null, expiresAt: null });
    const unified = await repository.readUnifiedSource(unknown);
    expect(unified.packages[0]).not.toHaveProperty("identityDetailsCollected");
    expect(unified.observations.one).not.toHaveProperty("identityDetails");
    const cache = await fixture.runtime.query<{ package_data: unknown; observed_at: Date | null }>(
      "SELECT package_data,observed_at FROM package_detail_cache WHERE tenant_id=$1 AND principal_id=$2", [unknown.tenantId, unknown.principalId]);
    expect(cache.rows[0]).toEqual({ package_data: null, observed_at: null });
    expect(await repository.claimDueDetails(unknown, unknown.principalId)).not.toBeNull();

    const empty = scope();
    await publish(empty, [{ ...summary(), identityDetailsCollected: true }], false);
    expect((await repository.get(empty, "one"))!.package).toMatchObject({
      identityDetailsCollected: true, detailFreshness: { state: "fresh" },
    });
    expect((await repository.get(empty, "one"))!.package).not.toHaveProperty("elementDetails");

    const legacyExact = scope();
    await publish(legacyExact, [summary()], false, ["one"]);
    expect((await repository.get(legacyExact, "one"))!.package).toMatchObject({
      identityDetailsCollected: true, detailFreshness: { state: "fresh" },
    });

    const legacyBroad = scope();
    const { identityDetailsCollected: _collected, ...legacyDetail } = detail();
    await publish(legacyBroad, [legacyDetail], false);
    expect((await repository.get(legacyBroad, "one"))!.package).toMatchObject({
      identityDetailsCollected: true, elementDetails: legacyDetail.elementDetails, detailFreshness: { state: "fresh" },
    });
  });

  it("deduplicates across repository instances under a database lock and bounds batches to twenty", async () => {
    const owner = scope();
    await publish(owner, Array.from({ length: 23 }, (_, index) => summary(`package-${index}`)));
    const other = new PackageInventoryRepository(fixture.runtime);
    const claims = await Promise.all([
      repository.claimDueDetails(owner, owner.principalId), other.claimDueDetails(owner, owner.principalId),
    ]);
    const jobs = claims.filter(job => job !== null);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ autoDetails: true, catalogOnly: false, scopeKind: "exact" });
    expect(jobs[0]!.requestedIds).toHaveLength(20);
  });

  it("enriches all saved readers without replacing summary state, catalog observations, or snapshots", async () => {
    const owner = scope();
    const catalog = await publish(owner, [{ ...summary(), isBlocked: true }]);
    const beforeRevision = await readUnifiedInventoryRevision(owner, fixture.runtime);
    await enrich(owner, [detail()]);
    const afterRevision = await readUnifiedInventoryRevision(owner, fixture.runtime);
    expect(afterRevision).not.toBe(beforeRevision);
    const saved = (await repository.get(owner, "one"))!;
    expect(saved.package).toMatchObject({
      displayName: "Catalog one", isBlocked: true, longDescription: "Saved detail description",
      elementDetails: detail().elementDetails, detailFreshness: { state: "fresh" },
    });
    expect((await repository.getMany(owner, ["one"]))[0].package).toEqual(saved.package);
    expect((await repository.list(owner)).value[0]).toEqual(saved.package);
    const unified = await repository.readUnifiedSource(owner);
    expect(unified.packages[0]).toEqual(saved.package);
    expect(unified.observations.one.snapshotId).toBe(catalog.snapshotId);
    expect(unified.observations.one.identityDetails?.observedAt).toBe(saved.package!.detailFreshness!.observedAt);
    expect((await repository.listSnapshots(owner)).value).toHaveLength(1);
    expect(await repository.claimDueDetails(owner, owner.principalId)).toBeNull();
  });

  it("lets catalog publication proceed during enrichment and retains independent detail freshness", async () => {
    const owner = scope();
    await publish(owner, [summary()]);
    const automatic = (await repository.claimDueDetails(owner, owner.principalId))!;
    await repository.markRunning(owner, automatic.id, true);
    await publish(owner, [{ ...summary(), displayName: "New catalog name", isBlocked: true }]);
    await repository.publish(owner, automatic.id, { packages: [detail()], totalRecords: 1, pages: 1, detailFailures: [] });
    expect((await repository.get(owner, "one"))?.package).toMatchObject({
      displayName: "New catalog name", isBlocked: true, longDescription: "Saved detail description",
    });
    const first = (await repository.get(owner, "one"))!.package!.detailFreshness;
    await publish(owner, [{ ...summary(), displayName: "Newest catalog name" }]);
    expect((await repository.get(owner, "one"))?.package?.detailFreshness).toEqual(first);
  });

  it("fences an in-flight read after catalog removal and re-addition, including identical revision markers", async () => {
    const owner = scope();
    await publish(owner, [summary()]);
    const automatic = (await repository.claimDueDetails(owner, owner.principalId))!;
    await repository.markRunning(owner, automatic.id, true);
    await publish(owner, []);
    await publish(owner, [summary()]);
    await repository.publish(owner, automatic.id, { packages: [detail()], totalRecords: 1, pages: 1, detailFailures: [] });
    expect((await repository.get(owner, "one"))?.package).not.toHaveProperty("elementDetails");
    expect((await repository.get(owner, "one"))?.package?.detailFreshness?.state).toBe("missing");
  });

  it("prioritizes changed or missing detail over stale hourly refresh and fences the old revision", async () => {
    const owner = scope();
    await publish(owner, [summary("old"), summary("changed")]);
    await enrich(owner, [detail("old"), detail("changed")]);
    await fixture.operator.query(`UPDATE package_detail_cache SET next_attempt_at=clock_timestamp()-interval '1 hour',
      observed_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour'
      WHERE tenant_id=$1 AND principal_id=$2`, [owner.tenantId, owner.principalId]);
    await publish(owner, [summary("old"), summary("changed", "2"), summary("new")]);
    const automatic = (await repository.claimDueDetails(owner, owner.principalId))!;
    expect(automatic.requestedIds).toEqual(["changed", "new", "old"]);
    const row = await fixture.operator.query<{ detail_targets: Array<{ id: string }> }>("SELECT detail_targets FROM package_refresh_jobs WHERE id=$1", [automatic.id]);
    expect(row.rows[0].detail_targets.map(value => value.id)).toEqual(["changed", "new", "old"]);
    expect((await repository.get(owner, "changed"))?.package?.detailFreshness?.state).toBe("missing");
  });

  it.each([false, true])("withdraws cached identity on successful omitted metadata (exact=%s) and on automatic 404", async exact => {
    const owner = scope();
    await publish(owner, [summary()]);
    await enrich(owner, [detail()]);
    await publish(owner, [{ ...summary(), identityDetailsCollected: true }], false, exact ? ["one"] : undefined);
    await publish(owner, [summary()]);
    expect((await repository.get(owner, "one"))?.package).not.toHaveProperty("elementDetails");
    await fixture.operator.query("UPDATE package_detail_cache SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND principal_id=$2", [owner.tenantId, owner.principalId]);
    const automatic = (await repository.claimDueDetails(owner, owner.principalId))!;
    await repository.markRunning(owner, automatic.id, true);
    await repository.publish(owner, automatic.id, {
      packages: [], totalRecords: 0, pages: 1, detailFailures: [{ id: "one", missing: true, errorCode: "not_found" }],
    });
    const saved = (await repository.get(owner, "one"))!;
    expect(saved.package?.detailFreshness?.state).toBe("invalidated");
    expect(saved.package).not.toHaveProperty("elementDetails");
    expect((await repository.readUnifiedSource(owner)).observations.one).not.toHaveProperty("identityDetails");
  });

  it("retains stale descriptive data but withdraws expired identity evidence and changes the unified revision", async () => {
    const owner = scope();
    await publish(owner, [summary()]);
    await enrich(owner, [detail()]);
    const before = await readUnifiedInventoryRevision(owner, fixture.runtime);
    await fixture.operator.query("UPDATE package_detail_cache SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND principal_id=$2", [owner.tenantId, owner.principalId]);
    const saved = (await repository.get(owner, "one"))!.package!;
    expect(saved).toMatchObject({ longDescription: "Saved detail description", detailFreshness: { state: "stale" }, identityRevalidationRequired: true });
    expect((await repository.readUnifiedSource(owner)).observations.one).not.toHaveProperty("identityDetails");
    expect(await readUnifiedInventoryRevision(owner, fixture.runtime)).not.toBe(before);
  });

  it("backs off failures and expired restart leases instead of resuming unowned provider work", async () => {
    const owner = scope();
    await publish(owner, [summary()]);
    const automatic = (await repository.claimDueDetails(owner, owner.principalId))!;
    await repository.markRunning(owner, automatic.id, true);
    await repository.recoverInterrupted();
    expect(await repository.getJob(owner, automatic.id)).toMatchObject({ status: "running", autoDetails: true });
    await fixture.operator.query("UPDATE package_refresh_jobs SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1", [automatic.id]);
    expect(await repository.claimDueDetails(owner, owner.principalId)).toBeNull();
    expect(await repository.getJob(owner, automatic.id)).toMatchObject({ status: "failed" });
    const cached = await fixture.runtime.query<{ failure_count: number; future: boolean }>(`SELECT failure_count,next_attempt_at>clock_timestamp() AS future
      FROM package_detail_cache WHERE tenant_id=$1 AND principal_id=$2`, [owner.tenantId, owner.principalId]);
    expect(cached.rows[0]).toEqual({ failure_count: 1, future: true });
  });

  it("publishes successful details independently and retries only failed targets after backoff", async () => {
    const owner = scope();
    await publish(owner, [summary("one"), summary("two")]);
    const automatic = (await repository.claimDueDetails(owner, owner.principalId))!;
    await repository.markRunning(owner, automatic.id, true);
    await repository.publish(owner, automatic.id, {
      packages: [detail("one")], totalRecords: 1, pages: 2,
      detailFailures: [{ id: "two", missing: false, errorCode: "provider_network_error" }],
    });
    expect((await repository.get(owner, "one"))?.package?.detailFreshness?.state).toBe("fresh");
    expect((await repository.get(owner, "two"))?.package?.detailFreshness?.state).toBe("missing");
    expect(await repository.getJob(owner, automatic.id)).toMatchObject({
      status: "failed", errorCode: "package_detail_read_failed", message: expect.stringContaining("1 deferred"),
    });
    const counts = await fixture.runtime.query<{ native_id: string; failure_count: number }>(`SELECT native_id,failure_count
      FROM package_detail_cache WHERE tenant_id=$1 AND principal_id=$2 ORDER BY native_id`, [owner.tenantId, owner.principalId]);
    expect(counts.rows).toEqual([{ native_id: "one", failure_count: 0 }, { native_id: "two", failure_count: 1 }]);
    expect(await repository.claimDueDetails(owner, owner.principalId)).toBeNull();
    await fixture.operator.query(`UPDATE package_detail_cache SET next_attempt_at=clock_timestamp()-interval '1 second'
      WHERE tenant_id=$1 AND principal_id=$2 AND native_id='two'`, [owner.tenantId, owner.principalId]);
    expect((await repository.claimDueDetails(owner, owner.principalId))?.requestedIds).toEqual(["two"]);
  });

  it("retains the previous cache and freshness while surfacing automatic read failures", async () => {
    const owner = scope();
    await publish(owner, [summary()]);
    await enrich(owner, [detail()]);
    const saved = (await repository.get(owner, "one"))!.package;
    const revision = await readUnifiedInventoryRevision(owner, fixture.runtime);
    await fixture.operator.query(`UPDATE package_detail_cache SET next_attempt_at=clock_timestamp()-interval '1 second'
      WHERE tenant_id=$1 AND principal_id=$2`, [owner.tenantId, owner.principalId]);
    const automatic = (await repository.claimDueDetails(owner, owner.principalId))!;
    await repository.markRunning(owner, automatic.id, true);
    await repository.publish(owner, automatic.id, {
      packages: [], totalRecords: 0, pages: 1,
      detailFailures: [{ id: "one", missing: false, errorCode: "provider_throttled" }],
    });
    expect((await repository.get(owner, "one"))!.package).toEqual(saved);
    expect(await readUnifiedInventoryRevision(owner, fixture.runtime)).toBe(revision);
    expect(await repository.latestAutomaticDetailsJob(owner, owner.principalId)).toMatchObject({
      id: automatic.id, status: "failed", errorCode: "package_detail_read_failed",
    });
  });

  it("clears detail generations with the saved-data reset trigger and cannot reuse old cached identity", async () => {
    const owner = scope();
    await publish(owner, [summary()]);
    await enrich(owner, [detail()]);
    await fixture.runtime.query(`INSERT INTO data_sync_runs(id,tenant_id,principal_id,mode,source_ids,request_hash,clear_saved_data)
      VALUES($1,$2,$3,'full','["users","graph_packages","power_platform"]',$4,true)`,
    [randomUUID(), owner.tenantId, owner.principalId, "a".repeat(64)]);
    expect((await fixture.runtime.query("SELECT native_id FROM package_detail_cache WHERE tenant_id=$1 AND principal_id=$2",
      [owner.tenantId, owner.principalId])).rows).toEqual([]);
    await publish(owner, [summary()]);
    expect((await repository.get(owner, "one"))?.package).not.toHaveProperty("elementDetails");
  });

  it("rejects catalog-only exact jobs and mismatched idempotent replay while persisting the mode", async () => {
    const owner = scope();
    const input = { authorizationPrincipalId: owner.principalId, tokenMode: "delegated" as const, idempotencyKey: randomUUID() };
    await expect(repository.submit(owner, { ...input, catalogOnly: true, requestedIds: ["one"] })).rejects.toMatchObject({ code: "invalid_package_refresh_mode" });
    const job = await repository.submit(owner, { ...input, catalogOnly: true });
    expect(await repository.getJob(owner, job.id)).toMatchObject({ catalogOnly: true });
    await expect(repository.submit(owner, input)).rejects.toMatchObject({ code: "idempotency_mismatch" });
  });
});
