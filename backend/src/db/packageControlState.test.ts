import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inventorySelectionFixture, reconcileInventoryFixture } from "../../scripts/inventoryFixtures.js";
import { testDatabase } from "../../scripts/testDatabase.js";
import { allowlistedPackage } from "../services/packageObservation.js";
import { capturePackageMutationState } from "../services/packageMutationState.js";
import { GraphPackagesClient } from "../services/graphPackages.js";
import { completeInventoryJob, inventoryJobInput } from "../services/inventoryRuntime.js";
import { StreamedInventory } from "../services/streamedInventory.js";
import { inventoryPresentation } from "../services/inventoryPresentation.js";
import type { CopilotPackageDetail } from "../types/copilotPackage.js";
import { unifiedAgentRecordId } from "../types/unifiedAgents.js";
import { PackageRefreshJobs, type PackageDataScope } from "./packageRefreshJobs.js";
import { publishPackageReadback, readPackageControls } from "./packageControls.js";
import { InventoryQueries } from "./inventoryQueries.js";
import { LiveInventory } from "./liveInventory.js";
import { transaction } from "./pool.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>, jobs: PackageRefreshJobs;
const manifestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function original(): CopilotPackageDetail {
  return { ...allowlistedPackage({
    id: "rain", displayName: "Rain watch", isBlocked: false, manifestId, version: "1",
    lastModifiedDateTime: "2026-09-20T08:00:00Z",
    elementTypes: ["DeclarativeCopilots"], availableTo: "allowedForAll", deployedTo: "none",
    elementDetails: [{ elementType: "DeclarativeCopilots", elements: [{ id: "", definition: "{}" }] }],
  }), identityDetailsCollected: true };
}
const sparse = (isBlocked: boolean, extra: Partial<CopilotPackageDetail> = {}) =>
  allowlistedPackage({ id: "rain", displayName: "Rain watch", isBlocked, ...extra });
const newScope = () => ({ tenantId: "control-projection-tenant", principalId: randomUUID() });
async function start(scope: PackageDataScope, targets?: string[], mode: "delegated" | "application" = "delegated") {
  const job = await jobs.submit(scope, { authorizationPrincipalId: scope.principalId, tokenMode: mode,
    requestedIds: targets, idempotencyKey: randomUUID() });
  expect(await jobs.markRunning(scope, job.id)).toBe(true);
  return { job, targets, mode };
}
async function collect(scope: PackageDataScope, work: Awaited<ReturnType<typeof start>>, values: CopilotPackageDetail[], expiresAt?: Date) {
  if (values.length > 2 || (work.targets?.length ?? 0) > 2) throw new Error("tiny_control_provider_fixture_limit");
  const provider = new GraphPackagesClient(async url => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/packages")) return Response.json({ value: values, "@odata.count": values.length });
    const value = values.find(item => item.id === decodeURIComponent(path.split("/").at(-1)!));
    return value ? Response.json(value) : Response.json({ error: { code: "notFound" } }, { status: 404 });
  }, { minimumReadIntervalMs: 0, maxAttempts: 1 });
  const input = await inventoryJobInput(fixture.runtime, scope, "packages", work.job.id);
  if (expiresAt) input.expiresAt = expiresAt;
  const stream = new StreamedInventory(fixture.runtime, provider);
  const hooks = { authorize: async () => {}, completeJob: completeInventoryJob(input, "packages") };
  const root = await (work.targets ? stream.exact(input, "synthetic", work.targets, hooks) : stream.graphCatalog(input, "synthetic", hooks));
  if (work.mode === "delegated") await reconcileInventoryFixture(fixture.runtime, scope);
  return root;
}
async function refresh(scope: PackageDataScope, values: CopilotPackageDetail[], targets?: string[],
  mode: "delegated" | "application" = "delegated", expiresAt?: Date) {
  return collect(scope, await start(scope, targets, mode), values, expiresAt);
}
async function control(scope: PackageDataScope, value: CopilotPackageDetail, action: "block" | "update-availability" = "block") {
  const id = await transaction(fixture.runtime, client =>
    publishPackageReadback(scope, value, client, null, capturePackageMutationState(value, action)));
  await reconcileInventoryFixture(fixture.runtime, scope);
  return id;
}
async function read(scope: PackageDataScope) {
  const selected = await inventorySelectionFixture(fixture.runtime, scope, {}, "packages");
  return { ...selected, detail: await selected.queries.packageDetail(selected.selection.id, selected.identity, "rain"),
    children: await selected.queries.children(selected.selection.id, selected.identity, "rain", { kind: "element", limit: 50 }) };
}
beforeAll(async () => { fixture = await testDatabase(); jobs = new PackageRefreshJobs(fixture.runtime); });
afterAll(async () => { await fixture?.close(); });

describe("persisted package control observations", () => {
  it("preserves independent block/access receipts without relabeling provider or identity observations", async () => {
    const scope = newScope();
    const identityRoot = await refresh(scope, [original()], ["rain"]);
    const { elementDetails: _elements, identityDetailsCollected: _collected, ...catalog } = original();
    const catalogRoot = await refresh(scope, [catalog]);
    const before = inventoryPresentation((await inventorySelectionFixture(fixture.runtime, scope)).raw);
    expect(before.value[0].observations.packageSnapshots.rain).toMatchObject({
      snapshotId: catalogRoot.baselineId, scopeKind: "broad", identityDetails: { snapshotId: identityRoot.baselineId, current: true },
    });
    const blockId = await control(scope, sparse(true));
    const accessId = await control(scope, sparse(false, {
      availableTo: "none", deployedTo: "none", allowedUsersAndGroups: [], acquireUsersAndGroups: [],
    }), "update-availability");
    const selected = await read(scope);
    expect(selected.detail).toMatchObject({ isBlocked: true, manifestId, availableTo: "none", deployedTo: "none",
      identityDetailsCollected: true, detailFreshness: { state: "fresh" },
      controlObservations: { block: { snapshotId: blockId }, access: { snapshotId: accessId } } });
    expect(selected.children.total).toBe(1);
    const after = inventoryPresentation((await inventorySelectionFixture(fixture.runtime, scope)).raw);
    expect(after.value[0].observations.packageSnapshots.rain).toEqual(before.value[0].observations.packageSnapshots.rain);
    const filtered = await inventorySelectionFixture(fixture.runtime, scope, { blocked: true, availableTo: "none" }, "packages");
    expect(filtered.raw.counts.filtered).toBe(1);
  });

  it.each([false, true])("does not let a late %s exact refresh undo a newer block; a later read can supersede it", async exact => {
    const scope = newScope();
    await refresh(scope, [original()], ["rain"]);
    const slow = await start(scope, exact ? ["rain"] : undefined);
    await fixture.operator.query("UPDATE package_refresh_jobs SET attempted_at=clock_timestamp()-interval '1 minute' WHERE id=$1", [slow.job.id]);
    await control(scope, sparse(true));
    await collect(scope, slow, [original()]);
    expect((await read(scope)).detail).toMatchObject({ isBlocked: true, manifestId });
    expect((await inventorySelectionFixture(fixture.runtime, scope, { blocked: true }, "packages")).raw.counts.filtered).toBe(1);
    await refresh(scope, [original()], exact ? ["rain"] : undefined);
    expect((await read(scope)).detail.isBlocked).toBe(false);
    expect((await inventorySelectionFixture(fixture.runtime, scope, { blocked: false }, "packages")).raw.counts.filtered).toBe(1);
    expect((await inventorySelectionFixture(fixture.runtime, scope, { blocked: true }, "packages")).raw.counts.filtered).toBe(0);
  });

  it("persists identity conflicts across sparse actions until an exact identity read revalidates them", async () => {
    const scope = newScope();
    await refresh(scope, [original()], ["rain"]);
    await control(scope, sparse(true, { manifestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }));
    await control(scope, sparse(false));
    expect((await read(scope)).detail).toMatchObject({ isBlocked: false, identityRevalidationRequired: true });
    await refresh(scope, [original()], ["rain"]);
    await control(scope, sparse(true));
    const selected = await read(scope);
    expect(selected.detail).not.toHaveProperty("identityRevalidationRequired");
    expect(selected.detail).toMatchObject({ isBlocked: true, manifestId });
  });

  it("uses reusable detailed identity children when detecting and persisting a control conflict", async () => {
    const scope = newScope();
    const metadata = (botId: string) => [{ elementType: "AgentMetadatas", elements: [{ id: "metadata",
      definition: JSON.stringify({ SourceIds: { EnvironmentId: manifestId, CdsBotId: botId, SchemaName: "cr_rain" } }) }] }];
    const detailed = { ...original(), lastModifiedDateTime: "2026-09-20T08:00:00Z",
      elementDetails: metadata("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb") };
    const { elementDetails: _details, identityDetailsCollected: _collected, ...summary } = detailed;
    await refresh(scope, [summary]);
    await refresh(scope, [detailed], ["rain"]);
    await refresh(scope, [summary]);
    const selected = await read(scope);
    expect(selected.detail).toMatchObject({ identityDetailsCollected: true, detailFreshness: { state: "fresh" } });
    expect(selected.children.value.map(row => row.payload)).toEqual(detailed.elementDetails.flatMap(group =>
      group.elements.map(element => ({ elementType: group.elementType, ...element }))));
    expect(selected.raw.value[0].residual).not.toHaveProperty("elementDetails");
    await control(scope, sparse(true, { elementDetails: metadata("cccccccc-cccc-4ccc-8ccc-cccccccccccc") }));
    await control(scope, sparse(false));
    expect((await read(scope)).detail.identityRevalidationRequired).toBe(true);
  });

  it("does not resurrect authoritatively absent source membership from retained control receipts", async () => {
    const scope = newScope();
    await refresh(scope, [original()], ["rain"]);
    await control(scope, sparse(true));
    await refresh(scope, [], ["rain"]);
    const selected = await inventorySelectionFixture(fixture.runtime, scope, {}, "packages");
    expect(selected.raw.value).toEqual([]);
    await expect(selected.queries.packageDetail(selected.selection.id, selected.identity, "rain"))
      .rejects.toMatchObject({ code: "inventory_record_not_found" });
    expect(await readPackageControls(fixture.runtime, scope, ["rain"])).toMatchObject([{ state: { kind: "block", isBlocked: true } }]);
  });

  it("does not extend source membership or label expired identity current after a control readback", async () => {
    const scope = newScope();
    await refresh(scope, [original()], ["rain"], "delegated", new Date(Date.now() + 2500));
    await control(scope, sparse(true));
    const selected = await read(scope);
    const live = new LiveInventory(fixture.runtime), id = unifiedAgentRecordId({ source: "graph_packages", packageId: "rain" });
    await expect(live.record(scope, id)).resolves.toMatchObject({ id: expect.stringMatching(/^agent:/) });
    await expect.poll(() => live.record(scope, id).then(() => "current", error => error.code),
      { interval: 100, timeout: 3500 }).toBe("agent_not_found");
    await expect(selected.queries.packageDetail(selected.selection.id, selected.identity, "rain"))
      .rejects.toMatchObject({ code: "selection_invalidated" });
    expect(await readPackageControls(fixture.runtime, scope, ["rain"])).toMatchObject([{ state: { kind: "block", isBlocked: true } }]);
  });

  it("keeps control receipts inside tenant/principal/delegated boundaries without replacing live authority with application data", async () => {
    const scope = newScope();
    await refresh(scope, [original()], ["rain"]);
    await control(scope, sparse(true));
    const selected = await read(scope);
    for (const other of [{ ...scope, principalId: "different" }, { ...scope, tenantId: "different" }]) {
      expect(await readPackageControls(fixture.runtime, other, ["rain"])).toEqual([]);
      await expect(selected.queries.packageDetail(selected.selection.id, { ...selected.identity, ...other }, "rain"))
        .rejects.toMatchObject({ code: "selection_invalidated" });
    }
    await fixture.runtime.query(`INSERT INTO capability_configuration(tenant_id,capability_id,enabled,shared_data_scope,updated_by)
      VALUES($1,'graph.package.read.application',true,true,$2) ON CONFLICT(tenant_id,capability_id)
      DO UPDATE SET enabled=true,shared_data_scope=true`, [scope.tenantId, scope.principalId]);
    const application = await refresh(scope, [original()], undefined, "application");
    const reader = new InventoryQueries(fixture.runtime, "synthetic-control-application-cursor", 7, scope);
    const captured = await reader.capture(selected.identity, application.scopeId, {}, "application");
    expect((await reader.page(captured.id, selected.identity)).value[0].residual.isBlocked).toBe(false);
    expect((await read(scope)).detail.isBlocked).toBe(true);
    expect(inventoryPresentation((await inventorySelectionFixture(fixture.runtime, scope)).raw).value[0].packages[0].isBlocked).toBe(true);
  });
});
