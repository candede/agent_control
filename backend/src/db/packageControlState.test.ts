import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { allowlistedPackage } from "../services/packageObservation.js";
import { capturePackageMutationState } from "../services/packageMutationState.js";
import type { CopilotPackageDetail } from "../types/copilotPackage.js";
import { PackageInventoryRepository, publishPackageReadback, type PackageDataScope } from "./packageInventory.js";
import { transaction } from "./pool.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let repository: PackageInventoryRepository;
const manifestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function original(): CopilotPackageDetail {
  return { ...allowlistedPackage({
    id: "rain", displayName: "Rain watch", isBlocked: false, manifestId, version: "1",
    elementTypes: ["DeclarativeCopilots"], availableTo: "allowedForAll", deployedTo: "none",
    elementDetails: [{ elementType: "DeclarativeCopilots", elements: [{ id: "", definition: "{}" }] }],
  }), identityDetailsCollected: true };
}
function sparse(isBlocked: boolean, extra: Partial<CopilotPackageDetail> = {}) {
  return allowlistedPackage({ id: "rain", displayName: "Rain watch", isBlocked, ...extra });
}
async function start(scope: PackageDataScope, requestedIds?: string[], tokenMode: "delegated" | "application" = "delegated", catalogOnly = false) {
  const job = await repository.submit(scope, { authorizationPrincipalId: scope.principalId, tokenMode, requestedIds, idempotencyKey: randomUUID(), catalogOnly });
  await repository.markRunning(scope, job.id);
  return job;
}
async function refresh(scope: PackageDataScope, values: CopilotPackageDetail[], requestedIds?: string[], tokenMode: "delegated" | "application" = "delegated", catalogOnly = false) {
  const job = await start(scope, requestedIds, tokenMode, catalogOnly);
  return repository.publish(scope, job.id, { packages: values, totalRecords: values.length, pages: 1 });
}
async function control(scope: PackageDataScope, value: CopilotPackageDetail, action: "block" | "update-availability" = "block") {
  return transaction(fixture.runtime, client => publishPackageReadback(scope, value, client, null, capturePackageMutationState(value, action)));
}
const newScope = () => ({ tenantId: "control-projection-tenant", principalId: randomUUID() });
beforeAll(async () => { fixture = await testDatabase(); repository = new PackageInventoryRepository(fixture.runtime); });
afterAll(async () => { await fixture?.close(); });

describe("persisted package control observations", () => {
  it("preserves independent block and access receipts without relabeling identity freshness", async () => {
    const scope = newScope();
    const inventory = await refresh(scope, [original()]);
    const blockId = await control(scope, sparse(true));
    const accessId = await control(scope, sparse(false, {
      availableTo: "none", deployedTo: "none", allowedUsersAndGroups: [], acquireUsersAndGroups: [],
    }), "update-availability");
    const source = await repository.readUnifiedSource(scope);
    expect(source.packages[0]).toMatchObject({
      isBlocked: true, manifestId, availableTo: "none", deployedTo: "none",
      controlObservations: { block: { snapshotId: blockId }, access: { snapshotId: accessId } },
    });
    expect(source.observations.rain.snapshotId).toBe(inventory.snapshotId);
    expect(source.observations.rain.identityDetails?.snapshotId).toBe(inventory.snapshotId);
    expect((await repository.list(scope, { blocked: true, availableTo: "none" })).count).toBe(1);
    expect((await repository.getMany(scope, ["rain"]))[0].package).toEqual(source.packages[0]);
    expect((await repository.get(scope, "rain"))?.package).toEqual(source.packages[0]);
  });

  it.each([false, true])("does not let a late %s exact refresh undo a newer block; a later read can supersede it", async exact => {
    const scope = newScope();
    await refresh(scope, [original()]);
    const slow = await start(scope, exact ? ["rain"] : undefined);
    await fixture.operator.query("UPDATE package_refresh_jobs SET attempted_at=clock_timestamp()-interval '1 minute' WHERE id=$1", [slow.id]);
    await control(scope, sparse(true));
    await repository.publish(scope, slow.id, { packages: [original()], totalRecords: 1, pages: 1 });
    expect((await repository.readUnifiedSource(scope)).packages[0]).toMatchObject({ isBlocked: true, manifestId });
    expect((await repository.get(scope, "rain"))?.package?.isBlocked).toBe(true);
    expect((await repository.list(scope, { blocked: true })).count).toBe(1);
    await fixture.operator.query("SELECT pg_sleep(0.005)");
    await refresh(scope, [original()], exact ? ["rain"] : undefined);
    expect((await repository.readUnifiedSource(scope)).packages[0].isBlocked).toBe(false);
    expect((await repository.get(scope, "rain"))?.package?.isBlocked).toBe(false);
    expect((await repository.list(scope, { blocked: false })).count).toBe(1);
    expect((await repository.list(scope, { blocked: true })).count).toBe(0);
  });

  it("persists identity conflicts across subsequent sparse actions until identity is revalidated", async () => {
    const scope = newScope();
    await refresh(scope, [original()]);
    await control(scope, sparse(true, { manifestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }));
    await control(scope, sparse(false));
    expect((await repository.readUnifiedSource(scope)).packages[0]).toMatchObject({
      isBlocked: false, identityRevalidationRequired: true,
    });
    expect((await repository.get(scope, "rain"))?.package).toMatchObject({ identityRevalidationRequired: true });
    await fixture.operator.query("SELECT pg_sleep(0.005)");
    await refresh(scope, [original()], ["rain"]);
    await control(scope, sparse(true));
    expect((await repository.readUnifiedSource(scope)).packages[0]).not.toHaveProperty("identityRevalidationRequired");
    expect((await repository.get(scope, "rain"))?.package).toMatchObject({ isBlocked: true, manifestId });
  });

  it("uses reusable detailed identity evidence consistently when detecting and persisting conflicts", async () => {
    const scope = newScope();
    const metadata = (botId: string) => [{
      elementType: "AgentMetadatas",
      elements: [{ id: "metadata", definition: JSON.stringify({
        SourceIds: { EnvironmentId: manifestId, CdsBotId: botId, SchemaName: "cr_rain" },
      }) }],
    }];
    const detailed = {
      ...original(), lastModifiedDateTime: "2026-09-20T08:00:00Z",
      elementDetails: metadata("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
    };
    const { elementDetails: _details, identityDetailsCollected: _collected, ...summary } = detailed;
    await refresh(scope, [summary], undefined, "delegated", true);
    await refresh(scope, [detailed], ["rain"]);
    await fixture.operator.query("SELECT pg_sleep(0.005)");
    await refresh(scope, [summary], undefined, "delegated", true);
    expect((await repository.readUnifiedSource(scope)).packages[0].elementDetails).toEqual(detailed.elementDetails);
    expect((await repository.get(scope, "rain"))?.package?.elementDetails).toEqual(detailed.elementDetails);
    expect((await repository.getMany(scope, ["rain"]))[0].package?.elementDetails).toEqual(detailed.elementDetails);
    expect((await repository.list(scope)).value[0].elementDetails).toEqual(detailed.elementDetails);
    await control(scope, sparse(true, { elementDetails: metadata("cccccccc-cccc-4ccc-8ccc-cccccccccccc") }));
    await control(scope, sparse(false));
    expect((await repository.readUnifiedSource(scope)).packages[0].identityRevalidationRequired).toBe(true);
    expect((await repository.get(scope, "rain"))?.package?.identityRevalidationRequired).toBe(true);
  });

  it("does not resurrect an authoritatively absent package or its expired identity", async () => {
    const scope = newScope();
    await refresh(scope, [original()]);
    await control(scope, sparse(true));
    await fixture.operator.query("SELECT pg_sleep(0.005)");
    await refresh(scope, [], ["rain"]);
    expect((await repository.readUnifiedSource(scope)).packages).toEqual([]);
    expect(await repository.get(scope, "rain")).toMatchObject({ package: null, targetState: "absent" });
    expect((await repository.getMany(scope, ["rain"]))[0].package).toBeNull();

    const expired = newScope();
    await refresh(expired, [original()]);
    await control(expired, sparse(true));
    await fixture.operator.query(`UPDATE package_inventory_snapshots SET expires_at=clock_timestamp()-interval '1 second'
      WHERE tenant_id=$1 AND principal_id=$2 AND observation_kind='inventory'`, [expired.tenantId, expired.principalId]);
    const detail = await repository.get(expired, "rain");
    expect(detail?.package).toMatchObject({ isBlocked: true });
    expect(detail?.package).not.toHaveProperty("manifestId");
    expect(detail?.package).not.toHaveProperty("elementDetails");
  });

  it("keeps control evidence within tenant, principal and delegated source boundaries", async () => {
    const scope = newScope();
    await refresh(scope, [original()]);
    await control(scope, sparse(true));
    for (const other of [{ ...scope, principalId: "different" }, { ...scope, tenantId: "different" }]) {
      expect(await repository.get(other, "rain")).toBeUndefined();
      expect((await repository.getMany(other, ["rain"]))[0].package).toBeNull();
      expect((await repository.readUnifiedSource(other)).packages).toEqual([]);
    }
    const application = await refresh(scope, [original()], undefined, "application");
    expect((await repository.list(scope, { snapshotId: application.snapshotId })).value[0].isBlocked).toBe(false);
    expect((await repository.getMany(scope, ["rain"]))[0].package?.isBlocked).toBe(false);
    expect((await repository.readUnifiedSource(scope)).packages[0].isBlocked).toBe(true);
  });
});
