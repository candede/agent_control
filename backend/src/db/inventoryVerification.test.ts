import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrap, grantRuntime, migrate } from "../../scripts/database.js";
import { fixturePassword, testDatabase } from "../../scripts/testDatabase.js";
import { allowlistedPackage } from "../services/packageObservation.js";
import { inventoryQueryTypes } from "../services/inventoryRoleScope.js";
import { PowerPlatformResourceQueryClient } from "../services/powerPlatformResourceQuery.js";
import { powerPlatformResourceTypes, type InventoryRoleScope, type PowerPlatformResourceType, type ResourceQueryResult } from "../types/powerPlatformInventory.js";
import { PackageInventoryRepository } from "./packageInventory.js";
import { PowerPlatformInventoryRepository } from "./powerPlatformInventory.js";
import { migrationChecksum, migrations, verifySchema } from "./schema.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => { fixture = await testDatabase(); });
afterAll(async () => { await fixture?.close(); });

const agentType = "microsoft.copilotstudio/agents";
const environmentId = "11111111-1111-4111-8111-111111111111";
const nativeIds = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"];

async function publishInventory(requestedTypes: readonly PowerPlatformResourceType[] = powerPlatformResourceTypes) {
  const scope = { tenantId: `verification-${randomUUID()}`, principalId: "reader" };
  const repository = new PowerPlatformInventoryRepository(fixture.runtime);
  const job = await repository.submit(scope, { idempotencyKey: "verify", roleScope: "unknown", requestedTypes });
  await repository.markRunning(scope, job.id);
  const query = new PowerPlatformResourceQueryClient(async () => Response.json({
    totalRecords: 2, count: 2, resultTruncated: 0,
    data: nativeIds.map(name => ({ name, tenantId: scope.tenantId, type: agentType, properties: { environmentId, displayName: name } })),
  }));
  const result = await query.query("fixture-token", requestedTypes, { expectedTenantId: scope.tenantId });
  expect(result.resources.every(resource => resource.environmentId === environmentId)).toBe(true);
  const saved = await repository.publish(scope, job.id, result);
  return { scope, repository, result, snapshotId: saved.snapshotId };
}

describe("saved inventory verification", () => {
  it("verifies actual saved counts independently of filtering, paging, and optional role hints", async () => {
    const { scope, repository, snapshotId } = await publishInventory();
    const page = await repository.list(scope, { search: nativeIds[0], limit: 1 });
    expect(page).toMatchObject({
      count: 1, value: [{ nativeId: nativeIds[0] }],
      snapshot: {
        id: snapshotId, roleScope: "unknown", observedCount: 2, totalRecords: 2, pageCount: 1,
        verification: { status: "verified", scope: "authorized_query", storedCount: 2, uniqueIdentityCount: 2, queriedTypes: powerPlatformResourceTypes },
      },
    });
    expect(page.typeCounts.find(item => item.type === agentType)).toMatchObject({ status: "covered", count: 1 });
    expect(page.snapshot?.coverage.find(item => item.type === agentType)).toMatchObject({ status: "covered", count: 2 });
    expect(page.snapshot?.coverage.find(item => item.type === "microsoft.powerapps/canvasapps")).toMatchObject({ status: "covered", count: 0 });
    await fixture.operator.query("UPDATE power_platform_inventory_snapshots SET role_scope='ai' WHERE id=$1", [snapshotId]);
    const changedHint = await repository.list(scope);
    expect(changedHint.snapshot?.coverage).toEqual(page.snapshot?.coverage);
    expect(changedHint.snapshot?.verification.queriedTypes).toEqual(powerPlatformResourceTypes);
  });

  it("rejects missing rows on every saved-data reader instead of repeating a successful job label", async () => {
    const { scope, repository, snapshotId } = await publishInventory();
    await fixture.operator.query("DELETE FROM power_platform_inventory_resources WHERE snapshot_id=$1 AND native_id=$2", [snapshotId, nativeIds[1]]);
    for (const read of [
      () => repository.list(scope),
      () => repository.listSnapshots(scope),
      () => repository.readUnifiedSource(scope),
      () => repository.readIdentityCandidates(scope, [agentType]),
      () => repository.getResource(scope, snapshotId, agentType, environmentId, nativeIds[0]),
      () => repository.getQuarantineSelection(scope, snapshotId, [nativeIds[0]]),
      () => repository.listQuarantineTargets(scope),
      () => repository.resolveQuarantineTargets(scope, snapshotId, [nativeIds[0]]),
    ]) {
      await expect(read()).rejects.toMatchObject({ code: "inventory_verification_failed" });
    }
  });

  it("uses the same latest source selection for activity identity links, without depending on role claims", async () => {
    const { scope, repository, result } = await publishInventory();
    const job = await repository.submit(scope, { idempotencyKey: "latest-agent-scope", roleScope: "full", requestedTypes: [agentType] });
    await repository.markRunning(scope, job.id);
    const latest = await repository.publish(scope, job.id, {
      ...result, queriedTypes: [agentType],
      resources: result.resources.map(resource => ({
        ...resource, identifiers: [{ kind: "entra_agent_id" as const, value: resource.nativeId }],
      })),
    });
    const candidates = await repository.readIdentityCandidates(scope, [agentType]);
    expect(candidates).toHaveLength(2);
    expect(candidates.every(candidate => candidate.identifiers.length === 1 && candidate.identifiers[0].kind === "entra_agent_id")).toBe(true);
    expect((await repository.readUnifiedSource(scope)).snapshot?.id).toBe(latest.snapshotId);
    expect(await repository.readIdentityCandidates({ ...scope, principalId: "different-reader" }, [agentType])).toEqual([]);
  });

  it.each(["types", "environment", "provider_total"] as const)("rejects inconsistent saved %s evidence even when the row count is unchanged", async change => {
    const { scope, repository, snapshotId } = await publishInventory();
    if (change === "types") await fixture.operator.query("UPDATE power_platform_inventory_snapshots SET queried_types='[\"microsoft.powerplatform/environments\"]' WHERE id=$1", [snapshotId]);
    else if (change === "environment") await fixture.operator.query("UPDATE power_platform_inventory_snapshots SET environment_scope='different-environment' WHERE id=$1", [snapshotId]);
    else await fixture.operator.query("UPDATE power_platform_inventory_snapshots SET total_records=1 WHERE id=$1", [snapshotId]);
    await expect(repository.list(scope)).rejects.toMatchObject({ code: "inventory_verification_failed" });
  });

  it("binds publication to the actual executed types and environment and requires integer page counts", async () => {
    const { scope, repository, result, snapshotId } = await publishInventory();
    const changes: Array<Partial<ResourceQueryResult>> = [
      { queriedTypes: [agentType] },
      { queriedTypes: [] },
      { environmentScope: environmentId },
      { pages: 1.5 },
    ];
    for (const [index, change] of changes.entries()) {
      const job = await repository.submit(scope, { idempotencyKey: `mismatch-${index}`, roleScope: "unknown", requestedTypes: powerPlatformResourceTypes });
      await repository.markRunning(scope, job.id);
      await expect(repository.publish(scope, job.id, { ...result, ...change })).rejects.toMatchObject({
        status: 409, code: "pages" in change ? "incomplete_inventory_coverage" : "scope_mismatch",
      });
      expect((await repository.list(scope)).snapshot?.id).toBe(snapshotId);
      await repository.markFailed(scope, job.id, "fixture_scope_failure", "Fixture scope verification failed.");
    }
  });

  it("does not relabel unqueried types as verified zero", async () => {
    const { scope, repository } = await publishInventory([agentType]);
    const snapshot = (await repository.list(scope)).snapshot!;
    expect(snapshot.verification.queriedTypes).toEqual([agentType]);
    expect(snapshot.coverage.find(item => item.type === "microsoft.powerapps/canvasapps")).toEqual({
      type: "microsoft.powerapps/canvasapps", status: "not_requested", count: null,
    });
  });

  it.each(["broad", "exact"] as const)("detects deleted %s package rows rather than treating them as empty inventory or a tombstone", async kind => {
    const scope = { tenantId: `verification-${randomUUID()}`, principalId: "reader" };
    const repository = new PackageInventoryRepository(fixture.runtime);
    const value = { ...allowlistedPackage({ id: "package", displayName: "Agent", isBlocked: false }), identityDetailsCollected: true as const };
    const broad = await repository.submit(scope, { idempotencyKey: "broad", authorizationPrincipalId: scope.principalId, tokenMode: "delegated" });
    await repository.markRunning(scope, broad.id);
    let saved = await repository.publish(scope, broad.id, { packages: [value], totalRecords: 1, pages: 1 });
    if (kind === "exact") {
      const exact = await repository.submit(scope, {
        idempotencyKey: "exact", authorizationPrincipalId: scope.principalId, tokenMode: "delegated", requestedIds: ["package"],
      });
      await repository.markRunning(scope, exact.id);
      saved = await repository.publish(scope, exact.id, { packages: [value], totalRecords: 1, pages: 1 });
    }
    expect((await repository.readUnifiedSource(scope)).packages).toHaveLength(1);
    await fixture.operator.query("DELETE FROM package_inventory_resources WHERE snapshot_id=$1", [saved.snapshotId]);
    await expect(repository.readUnifiedSource(scope)).rejects.toMatchObject({ code: "inventory_verification_failed" });
  });
});

describe("inventory verification schema upgrade", () => {
  it("replaces role-derived coverage with actual query scope without changing roles, totals, or migration32", async () => {
    const upgrade = await testDatabase(false);
    try {
      await bootstrap(upgrade.operator, fixturePassword);
      await migrate(upgrade.operator, migrations.filter(step => step.version <= 32));
      const rows: Array<{ id: string; role: InventoryRoleScope; queried: PowerPlatformResourceType[] }> = [];
      for (const role of ["full", "ai", "unknown"] as const) {
        const id = randomUUID();
        const queried = inventoryQueryTypes(role, powerPlatformResourceTypes);
        const coverage = powerPlatformResourceTypes.map(type => ({
          type, status: !queried.includes(type) ? "not_authorized_scope" : role === "unknown" ? "unknown" : "covered",
          count: role === "unknown" || !queried.includes(type) ? null : 0,
        }));
        await upgrade.operator.query(`INSERT INTO power_platform_inventory_snapshots(
          id,tenant_id,principal_id,query_hash,role_scope,requested_types,coverage,observed_count,total_records,page_count,unknown_field_count)
          VALUES($1,'upgrade',$2,repeat('a',64),$2,$3::jsonb,$4::jsonb,0,0,1,0)`,
        [id, role, JSON.stringify(powerPlatformResourceTypes), JSON.stringify(coverage)]);
        rows.push({ id, role, queried });
      }
      await migrate(upgrade.operator);
      await migrate(upgrade.operator);
      await grantRuntime(upgrade.operator);
      await verifySchema(upgrade.runtime);
      expect(migrationChecksum(migrations.find(step => step.version === 32)!.sql))
        .toBe("9f1ed70e6403658b453a4664e57b3a3f58bac25764e2b549bea859259089d60f");
      expect((await upgrade.operator.query(`SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='power_platform_inventory_snapshots' AND column_name='coverage'`)).rowCount).toBe(0);
      const repository = new PowerPlatformInventoryRepository(upgrade.runtime);
      for (const row of rows) {
        const snapshot = (await repository.list({ tenantId: "upgrade", principalId: row.role })).snapshot!;
        expect(snapshot).toMatchObject({
          id: row.id, roleScope: row.role, totalRecords: 0, observedCount: 0,
          verification: { status: "verified", storedCount: 0, uniqueIdentityCount: 0, queriedTypes: row.queried },
        });
        expect(snapshot.coverage.find(item => item.type === agentType)).toMatchObject({ status: "covered", count: 0 });
      }
    } finally {
      await upgrade.close();
    }
  }, 30_000);
});
