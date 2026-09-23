import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { retain } from "../../scripts/database.js";
import { testDatabase } from "../../scripts/testDatabase.js";
import { allowlistedPackage } from "../services/packageObservation.js";
import { PackageInventoryRepository } from "./packageInventory.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let repository: PackageInventoryRepository;
const scope = { tenantId: "tenant-package", principalId: "reader-package" };

beforeAll(async () => {
  fixture = await testDatabase();
  repository = new PackageInventoryRepository(fixture.runtime);
});
afterAll(async () => { await fixture?.close(); });

function packageValue(id: string, blocked = false, overrides: Record<string, unknown> = {}) {
  return allowlistedPackage({
    id,
    displayName: `Package ${id}`,
    isBlocked: blocked,
    supportedHosts: ["Copilot"],
    appId: `app-${id}`,
    manifestId: `manifest-${id}`,
    assetId: `asset-${id}`,
    ...overrides,
  });
}

async function running(idempotencyKey: string, requestedIds?: string[]) {
  const job = await repository.submit(scope, {
    authorizationPrincipalId: scope.principalId,
    tokenMode: "delegated",
    idempotencyKey,
    requestedIds,
  });
  expect(await repository.markRunning(scope, job.id)).toBe(true);
  return job.id;
}

describe.sequential("Package inventory repository", () => {
  it("gives admitted package work a fresh four-hour deadline and publishes beyond the old thirty-minute window", async () => {
    const longScope = { tenantId: "tenant-long-package-refresh", principalId: "reader-long-package-refresh" };
    const job = await repository.submit(longScope, {
      authorizationPrincipalId: longScope.principalId, tokenMode: "delegated", idempotencyKey: "long-refresh",
    });
    const submitted = await fixture.operator.query<{ seconds: number }>(
      "SELECT EXTRACT(EPOCH FROM (deadline_at-created_at))::double precision AS seconds FROM package_refresh_jobs WHERE id=$1", [job.id]);
    expect(submitted.rows[0].seconds).toBeCloseTo(4 * 60 * 60, 1);
    await fixture.operator.query("UPDATE package_refresh_jobs SET created_at=clock_timestamp()-interval '2 hours',deadline_at=clock_timestamp()+interval '1 minute' WHERE id=$1", [job.id]);
    expect(await repository.markRunning(longScope, job.id)).toBe(true);
    const admitted = await fixture.operator.query<{ seconds: number }>(
      "SELECT EXTRACT(EPOCH FROM (deadline_at-attempted_at))::double precision AS seconds FROM package_refresh_jobs WHERE id=$1", [job.id]);
    expect(admitted.rows[0].seconds).toBeCloseTo(4 * 60 * 60, 1);
    await fixture.operator.query("UPDATE package_refresh_jobs SET attempted_at=clock_timestamp()-interval '1 hour',deadline_at=clock_timestamp()+interval '3 hours' WHERE id=$1", [job.id]);
    await repository.recordProgress(longScope, job.id, 1, 1, 1, "Active long-running collection.");
    await repository.publish(longScope, job.id, { packages: [packageValue("long-collected")], totalRecords: 1, pages: 1 });
    expect(await repository.getJob(longScope, job.id)).toMatchObject({ status: "succeeded", observedCount: 1 });
  });

  it("does not let retained dispatch-expired jobs exhaust fresh admission", async () => {
    const expiredScope = { tenantId: "tenant-package-deadline", principalId: "reader-package-deadline" };
    const input = { authorizationPrincipalId: expiredScope.principalId, tokenMode: "delegated" as const };
    const expiredJobs = [];
    for (let index = 0; index < 5; index += 1) {
      expiredJobs.push(await repository.submit(expiredScope, { ...input, idempotencyKey: `expired-${index}` }));
    }
    await fixture.runtime.query(`UPDATE package_refresh_jobs SET deadline_at=clock_timestamp()-interval '1 second'
      WHERE tenant_id=$1 AND principal_id=$2`, [expiredScope.tenantId, expiredScope.principalId]);
    expect(await repository.markRunning(expiredScope, expiredJobs[0].id)).toBe(false);

    for (let index = 0; index < 5; index += 1) {
      await expect(repository.submit(expiredScope, { ...input, idempotencyKey: `fresh-${index}` }))
        .resolves.toMatchObject({ status: "waiting_authorization" });
    }
    await expect(repository.submit(expiredScope, { ...input, idempotencyKey: "fresh-over-limit" }))
      .rejects.toMatchObject({ code: "job_limit" });
    expect(await repository.getJob(expiredScope, expiredJobs[0].id)).toBeDefined();
  });

  it("cancels only the requesting principal's unfinished read job", async () => {
    const job = await repository.submit(scope, {
      authorizationPrincipalId: scope.principalId, tokenMode: "delegated", idempotencyKey: "package-cancel",
    });
    expect(await repository.cancel({ ...scope, principalId: "other-reader" }, job.id, scope.principalId)).toBeUndefined();
    expect(await repository.cancel(scope, job.id, "other-reader")).toMatchObject({ status: "waiting_authorization" });
    expect(await repository.cancel(scope, job.id, scope.principalId)).toMatchObject({ status: "cancelled", errorCode: "cancelled" });
  });

  it("retains internal sync cleanup provenance instead of blaming the requesting principal", async () => {
    const job = await repository.submit(scope, {
      authorizationPrincipalId: scope.principalId, tokenMode: "delegated", idempotencyKey: "package-sync-cleanup",
    });
    await repository.cancel(scope, job.id, scope.principalId, "sync_cleanup");
    await repository.cancel(scope, job.id, scope.principalId);
    expect(await repository.getJob(scope, job.id)).toMatchObject({
      status: "cancelled", errorCode: "data_sync_cleanup", message: expect.stringContaining("original failure or interruption"),
    });
  });

  it("publishes complete allowlisted snapshots and scopes filters before counts and paging", async () => {
    const id = await running("package-broad");
    await repository.publish(scope, id, { packages: [packageValue("b", true), packageValue("a")], totalRecords: 2, pages: 2 });
    expect(await repository.list(scope, { search: "Package", blocked: false, limit: 1 })).toMatchObject({
      count: 1,
      value: [{ id: "a", sourceSystem: "graph_packages" }],
      snapshot: { scopeKind: "broad", observedCount: 2, pageCount: 2 },
      summary: { total: 2, allowed: 1, blocked: 1 },
      filteredSummary: { total: 1, allowed: 1, blocked: 0 },
    });
    expect(await repository.list({ ...scope, principalId: "other-reader" })).toMatchObject({ value: [], count: 0, snapshot: null, summary: { total: 0 } });
    const identifiers = await fixture.runtime.query<{ count: number }>("SELECT count(*)::int AS count FROM source_identifiers WHERE tenant_id=$1 AND source='graph_packages'", [scope.tenantId]);
    expect(identifiers.rows[0].count).toBe(8);
  });

  it("keeps broad data current when exact refreshes publish or fail", async () => {
    const exact = await running("package-exact", ["c"]);
    await repository.publish(scope, exact, { packages: [packageValue("c")], totalRecords: 1, pages: 1 });
    expect((await repository.list(scope)).value.map(value => value.id)).toEqual(["a", "b"]);
    expect((await repository.get(scope, "c"))?.package.id).toBe("c");

    const failed = await running("package-failed");
    await repository.recordProgress(scope, failed, 1, 1, 2);
    await repository.markFailed(scope, failed, "provider_error", "The complete scan failed.");
    expect(await repository.getJob(scope, failed)).toMatchObject({ status: "failed", pageCount: 1, observedCount: 1, totalRecords: 2 });
    expect((await repository.list(scope)).count).toBe(2);
  });

  it("loads only exact authorized targets without broad enumeration", async () => {
    expect(await repository.getMany(scope, ["c", "a", "missing"])).toMatchObject([
      { id: "c", package: { id: "c" } },
      { id: "a", package: { id: "a" } },
      { id: "missing", package: null },
    ]);
    expect(await repository.getMany({ ...scope, principalId: "other-reader" }, ["a", "c"])).toEqual([
      { id: "a", package: null },
      { id: "c", package: null },
    ]);
  });

  it("rejects incomplete, duplicate, and out-of-scope publication without replacing saved data", async () => {
    const incomplete = await running("package-incomplete");
    await expect(repository.publish(scope, incomplete, { packages: [packageValue("partial")], totalRecords: 2, pages: 1 })).rejects.toMatchObject({ code: "incomplete_package_coverage" });
    const exact = await running("package-wrong-target", ["expected"]);
    await expect(repository.publish(scope, exact, { packages: [packageValue("other")], totalRecords: 1, pages: 1 })).rejects.toMatchObject({ code: "package_scope_mismatch" });
    expect((await repository.list(scope)).value.map(value => value.id)).toEqual(["a", "b"]);
  });

  it("pages, filters, sorts, counts and facets beyond the first page without returning all rows", async () => {
    const values = Array.from({ length: 73 }, (_, index) => packageValue(
      `boundary-${String(index).padStart(3, "0")}`,
      index % 3 === 0,
      {
        publisher: index % 2 === 0 ? "Even publisher" : "Odd publisher",
        availableTo: index % 4 === 0 ? "some" : "none",
        supportedHosts: index % 5 === 0 ? ["Teams"] : ["Copilot"],
        platform: index % 7 === 0 ? "CopilotStudio" : "OtherPlatform",
        createdDateTime: index < 60 ? new Date().toISOString() : "2020-01-01T00:00:00.000Z",
      },
    ));
    const id = await running("package-boundary");
    await repository.publish(scope, id, { packages: values, totalRecords: values.length, pages: 2 });
    const secondPage = await repository.list(scope, {
      publisher: "Even publisher",
      blocked: false,
      host: "Copilot",
      platform: "Other Platform",
      createdWithinDays: 1,
      sortBy: "displayName",
      sortDirection: "desc",
      limit: 10,
      offset: 10,
    });
    expect(secondPage.value).toHaveLength(3);
    expect(secondPage.count).toBe(13);
    expect(secondPage.summary).toEqual({ total: 73, allowed: 48, blocked: 25 });
    expect(secondPage.filteredSummary).toEqual({ total: 13, allowed: 13, blocked: 0 });
    expect(secondPage.facets.publishers.map(option => option.value)).toEqual(["Even publisher", "Odd publisher"]);
    expect(secondPage.value[0].id > secondPage.value.at(-1)!.id).toBe(true);
  });

  it("overlays exact state without resurrecting stale identity details across provider revisions", async () => {
    const unifiedScope = { tenantId: "tenant-package-unified", principalId: "reader-package-unified" };
    const revisionA = "2026-09-10T10:00:00.000Z";
    const revisionB = "2026-09-11T10:00:00.000Z";
    const broad = await repository.submit(unifiedScope, {
      authorizationPrincipalId: unifiedScope.principalId,
      tokenMode: "delegated",
      idempotencyKey: "unified-broad",
    });
    expect(await repository.markRunning(unifiedScope, broad.id)).toBe(true);
    await repository.publish(unifiedScope, broad.id, {
      packages: [packageValue("retain"), packageValue("delete")],
      totalRecords: 2,
      pages: 1,
    });
    const exact = await repository.submit(unifiedScope, {
      authorizationPrincipalId: unifiedScope.principalId,
      tokenMode: "delegated",
      idempotencyKey: "unified-exact",
      requestedIds: ["delete", "new"],
    });
    expect(await repository.markRunning(unifiedScope, exact.id)).toBe(true);
    await repository.publish(unifiedScope, exact.id, {
      packages: [packageValue("new", false, {
        lastModifiedDateTime: revisionA,
        version: "1",
        elementDetails: [{
          elementType: "AgentMetadatas",
          elements: [{ id: "metadata", definition: "{\"fixture\":\"synthetic\"}" }],
        }],
      })],
      totalRecords: 1,
      pages: 1,
    });
    const application = await repository.submit(unifiedScope, {
      authorizationPrincipalId: unifiedScope.principalId,
      tokenMode: "application",
      idempotencyKey: "unified-application",
    });
    expect(await repository.markRunning(unifiedScope, application.id)).toBe(true);
    await repository.publish(unifiedScope, application.id, {
      packages: [packageValue("application-only")],
      totalRecords: 1,
      pages: 1,
    });
    const newerBroad = await repository.submit(unifiedScope, {
      authorizationPrincipalId: unifiedScope.principalId,
      tokenMode: "delegated",
      idempotencyKey: "unified-newer-broad",
    });
    expect(await repository.markRunning(unifiedScope, newerBroad.id)).toBe(true);
    await repository.publish(unifiedScope, newerBroad.id, {
      packages: [packageValue("retain"), packageValue("new", true, {
        lastModifiedDateTime: revisionA,
        version: "1",
      })],
      totalRecords: 2,
      pages: 1,
    });

    const source = await repository.readUnifiedSource(unifiedScope);
    expect(source.packages.map(value => value.id)).toEqual(["new", "retain"]);
    expect(source.packages.find(value => value.id === "new")).toMatchObject({
      isBlocked: true,
      elementDetails: [{ elementType: "AgentMetadatas" }],
    });
    expect(source.observations.new).toMatchObject({
      scopeKind: "broad",
      identityDetails: { snapshotId: expect.any(String) },
    });
    expect(source.snapshot).toMatchObject({ scopeKind: "broad", tokenMode: "delegated", observedCount: 2 });

    const changedBroad = await repository.submit(unifiedScope, {
      authorizationPrincipalId: unifiedScope.principalId,
      tokenMode: "delegated",
      idempotencyKey: "unified-changed-broad",
    });
    expect(await repository.markRunning(unifiedScope, changedBroad.id)).toBe(true);
    await repository.publish(unifiedScope, changedBroad.id, {
      packages: [packageValue("retain"), packageValue("new", false, {
        lastModifiedDateTime: revisionB,
        version: "2",
        appId: "changed-app-new",
      })],
      totalRecords: 2,
      pages: 1,
    });
    const changed = await repository.readUnifiedSource(unifiedScope);
    expect(changed.packages.find(value => value.id === "new")).not.toHaveProperty("elementDetails");
    expect(changed.observations.new).not.toHaveProperty("identityDetails");

    const emptyExact = await repository.submit(unifiedScope, {
      authorizationPrincipalId: unifiedScope.principalId,
      tokenMode: "delegated",
      idempotencyKey: "unified-empty-exact",
      requestedIds: ["new"],
    });
    expect(await repository.markRunning(unifiedScope, emptyExact.id)).toBe(true);
    await repository.publish(unifiedScope, emptyExact.id, {
      packages: [packageValue("new", false, {
        lastModifiedDateTime: revisionA,
        version: "1",
        elementDetails: [],
      })],
      totalRecords: 1,
      pages: 1,
    });
    const explicitlyEmpty = await repository.readUnifiedSource(unifiedScope);
    expect(explicitlyEmpty.packages.find(value => value.id === "new")).toMatchObject({ elementDetails: [] });
    expect(explicitlyEmpty.observations.new).toMatchObject({ scopeKind: "exact" });
    expect(explicitlyEmpty.observations.new).not.toHaveProperty("identityDetails");

    const absentExact = await repository.submit(unifiedScope, {
      authorizationPrincipalId: unifiedScope.principalId,
      tokenMode: "delegated",
      idempotencyKey: "unified-absent-exact",
      requestedIds: ["new"],
    });
    expect(await repository.markRunning(unifiedScope, absentExact.id)).toBe(true);
    await repository.publish(unifiedScope, absentExact.id, {
      packages: [],
      totalRecords: 0,
      pages: 1,
    });
    expect((await repository.readUnifiedSource(unifiedScope)).packages.map(value => value.id)).toEqual(["retain"]);
  });

  it("applies finite retention without granting runtime snapshot deletion", async () => {
    await fixture.operator.query("UPDATE package_inventory_snapshots SET expires_at=clock_timestamp()-interval '1 second'");
    await fixture.operator.query("UPDATE package_refresh_jobs SET expires_at=clock_timestamp()-interval '1 second' WHERE status<>'running'");
    await retain(fixture.operator);
    expect(await repository.list(scope)).toMatchObject({ value: [], count: 0, snapshot: null, summary: { total: 0 } });
    await expect(fixture.runtime.query("DELETE FROM package_inventory_snapshots")).rejects.toThrow();
  });
});