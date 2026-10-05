import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { PackageRefreshJobs } from "./packageRefreshJobs.js";
import { verifySchema } from "./schema.js";
import { GraphPackagesClient, buildCopilotAgentsListUrl } from "../services/graphPackages.js";
import { StreamedInventory } from "../services/streamedInventory.js";
import { completeInventoryJob, inventoryJobInput, InventoryRuntime } from "../services/inventoryRuntime.js";

describe("streamed package refresh contract", () => {
  let fixture: Awaited<ReturnType<typeof testDatabase>>;
  beforeAll(async () => { fixture = await testDatabase(); }, 30_000);
  afterAll(async () => { await fixture?.close(); });

  it.each([undefined, 2])("publishes a catalogue with provider count hint %s without detail fan-out or false progress totals", async expected => {
    await verifySchema(fixture.runtime);
    const scope = { tenantId: randomUUID(), principalId: randomUUID() };
    const jobs = new PackageRefreshJobs(fixture.runtime);
    const job = await jobs.submit(scope, { tokenMode: "delegated", authorizationPrincipalId: scope.principalId,
      idempotencyKey: randomUUID() });
    expect(job.snapshotId).toBeNull();
    expect(job).not.toHaveProperty("catalogOnly");
    expect(await jobs.markRunning(scope, job.id)).toBe(true);
    const next = new URL(buildCopilotAgentsListUrl());
    next.searchParams.set("$skiptoken", "second");
    const graph = new GraphPackagesClient(async url => {
      const second = new URL(url).searchParams.has("$skiptoken");
      return Response.json({ value: [{ id: second ? "second" : "first", displayName: "Synthetic agent", isBlocked: false }],
        ...(!second ? { "@odata.nextLink": next.href } : {}), ...(expected !== undefined ? { "@odata.count": expected } : {}) });
    });
    const detail = vi.spyOn(graph, "getPackageDetails").mockRejectedValue(new Error("Catalogue refresh must not fan out detail reads."));
    const input = await inventoryJobInput(fixture.runtime, scope, "packages", job.id);
    const progress: Array<{ observedCount: number; totalRecords: number | null }> = [];
    const root = await new StreamedInventory(fixture.runtime, graph).graphCatalog(input, "synthetic", {
      authorize: async () => {}, completeJob: completeInventoryJob(input, "packages"),
      onProgress: async value => {
        await jobs.recordProgress(scope, job.id, value.pages, value.observedCount, value.totalRecords ?? null);
        const current = (await jobs.getJob(scope, job.id))!;
        progress.push({ observedCount: current.observedCount, totalRecords: current.totalRecords });
      },
    });
    expect(detail).not.toHaveBeenCalled();
    expect(progress).toEqual([{ observedCount: 1, totalRecords: null }, { observedCount: 2, totalRecords: 2 }]);
    expect(await jobs.getJob(scope, job.id)).toMatchObject({
      status: "succeeded", pageCount: 2, observedCount: 2, totalRecords: 2, snapshotId: root.baselineId, targetCount: 0,
    });
    const runtime = new InventoryRuntime(fixture.runtime, async () => {});
    try {
      await runtime.pass();
      expect((await fixture.runtime.query(`SELECT r.row_count FROM inventory_roots r
        JOIN data_scope_epochs s ON s.id=r.scope_id WHERE s.tenant_id=$1 AND s.principal_id=$2
          AND s.source='inventory_canonical' AND r.current`, [scope.tenantId, scope.principalId])).rows)
        .toEqual([{ row_count: 2 }]);
    } finally { await runtime.drain(); }
  });

});
