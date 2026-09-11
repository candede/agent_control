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

  it("applies finite retention without granting runtime snapshot deletion", async () => {
    await fixture.operator.query("UPDATE package_inventory_snapshots SET expires_at=clock_timestamp()-interval '1 second'");
    await fixture.operator.query("UPDATE package_refresh_jobs SET expires_at=clock_timestamp()-interval '1 second' WHERE status<>'running'");
    await retain(fixture.operator);
    expect(await repository.list(scope)).toMatchObject({ value: [], count: 0, snapshot: null, summary: { total: 0 } });
    await expect(fixture.runtime.query("DELETE FROM package_inventory_snapshots")).rejects.toThrow();
  });
});