import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { testDatabase } from "../../scripts/testDatabase.js";
import { inventorySelectionFixture, packageRecord, refreshInventoryFixture } from "../../scripts/inventoryFixtures.js";
import { completeInventoryJob, inventoryJobInput } from "../services/inventoryRuntime.js";
import { DataSyncRepository } from "./dataSync.js";
import { InventoryGenerations } from "./inventoryGenerations.js";
import { PackageRefreshJobs } from "./packageRefreshJobs.js";

describe("streamed package publication transaction", () => {
  let fixture: Awaited<ReturnType<typeof testDatabase>>;
  let jobs: PackageRefreshJobs;
  beforeAll(async () => { fixture = await testDatabase(); jobs = new PackageRefreshJobs(fixture.runtime); });
  afterAll(async () => { await fixture?.close(); });
  async function start(scope: { tenantId: string; principalId: string }) {
    const job = await jobs.submit(scope, { authorizationPrincipalId: scope.principalId,
      tokenMode: "delegated", idempotencyKey: randomUUID() });
    await jobs.markRunning(scope, job.id);
    return job;
  }
  async function initial() {
    const scope = { tenantId: randomUUID(), principalId: randomUUID() };
    const job = await start(scope);
    const root = await refreshInventoryFixture(fixture.runtime, scope, job.id, "packages", [packageRecord(0, "Original")]);
    const selected = await inventorySelectionFixture(fixture.runtime, scope, {}, "packages");
    return { scope, root, selected };
  }
  async function publish(scope: { tenantId: string; principalId: string }, jobId: string,
    beforeCompletion?: (client: pg.PoolClient) => Promise<void>, afterCompletion?: (client: pg.PoolClient) => Promise<void>) {
    const input = await inventoryJobInput(fixture.runtime, scope, "packages", jobId);
    const store = new InventoryGenerations(fixture.runtime);
    return store.execute(input, { domain: "packages", mode: "baseline", channel: "catalog" }, async lease => {
      const records = [packageRecord(0, "Replacement"), packageRecord(1, "New")];
      await store.visit(lease, "publication");
      await store.appendBounded(lease, records);
      await store.acceptPage(lease, { token: "publication", nextToken: null, records, rawCount: 2, expectedCount: 2, page: 1 }, 2);
    }, { authorize: async () => {}, completeJob: async (client, result) => {
      await beforeCompletion?.(client);
      await completeInventoryJob(input, "packages")(client, result);
      await afterCompletion?.(client);
    } });
  }
  async function assertOriginal(value: Awaited<ReturnType<typeof initial>>) {
    const current = await inventorySelectionFixture(fixture.runtime, value.scope, {}, "packages");
    expect(current.raw.value.map(row => row.displayName)).toEqual(["Original"]);
    expect((await value.selected.queries.page(value.selected.selection.id, value.selected.identity)).value)
      .toEqual(value.selected.raw.value);
    expect((await fixture.runtime.query("SELECT baseline_id FROM inventory_roots WHERE scope_id=$1 AND current",
      [value.root.scopeId])).rows).toEqual([{ baseline_id: value.root.baselineId }]);
  }

  it("commits the source head, refresh job, run source and success marker together", async () => {
    const { scope } = await initial();
    const sync = new DataSyncRepository(fixture.runtime);
    const { run } = await sync.submit(scope, { mode: "incremental", sources: ["graph_packages"] });
    const job = await start(scope);
    await sync.attachJob(scope, run.id, "graph_packages", job.id);
    await sync.updateSource(scope, run.id, "graph_packages", {
      status: "running", jobId: job.id, message: "Publishing synthetic source.", canRetry: false,
    });
    let checked = false;
    await publish(scope, job.id, undefined, async client => {
      const state = (await client.query(`SELECT job.status,source.status AS source_status,source.count,marker.count AS marker_count
        FROM package_refresh_jobs job JOIN data_sync_run_sources source ON source.job_id=job.id
        JOIN data_sync_success_markers marker ON marker.tenant_id=job.tenant_id AND marker.principal_id=job.principal_id
          AND marker.source_id='graph_packages' WHERE job.id=$1`, [job.id])).rows[0];
      expect(state).toEqual({ status: "succeeded", source_status: "succeeded", count: 2, marker_count: 2 });
      expect((await client.query(`SELECT 1 FROM inventory_roots root JOIN inventory_revisions revision
        ON revision.scope_id=root.scope_id AND revision.revision=root.revision
        JOIN data_generations generation ON generation.id=revision.generation_id
        WHERE root.current AND generation.job_id=$1`, [job.id])).rowCount).toBe(1);
      checked = true;
    });
    expect(checked).toBe(true);
    expect(await jobs.getJob(scope, job.id)).toMatchObject({ status: "succeeded", observedCount: 2 });
    expect((await inventorySelectionFixture(fixture.runtime, scope, {}, "packages")).raw.counts.filtered).toBe(2);
  });

  it.each(["status", "deadline_at", "expires_at"] as const)("rolls back source replacement when the final %s fence fails", async field => {
    const original = await initial();
    const job = await start(original.scope);
    await expect(publish(original.scope, job.id, async client => {
      await client.query(field === "status" ? "UPDATE package_refresh_jobs SET status='cancelled' WHERE id=$1"
        : `UPDATE package_refresh_jobs SET ${field}=clock_timestamp() WHERE id=$1`, [job.id]);
    })).rejects.toMatchObject({ code: "inventory_job_fenced" });
    expect(await jobs.getJob(original.scope, job.id)).toMatchObject({ status: "running" });
    await assertOriginal(original);
    await jobs.cancel(original.scope, job.id, original.scope.principalId);
  });

  it("rolls back source, run and job success if the final publication write fails", async () => {
    const original = await initial();
    const sync = new DataSyncRepository(fixture.runtime);
    const { run } = await sync.submit(original.scope, { mode: "incremental", sources: ["graph_packages"] });
    const job = await start(original.scope);
    await sync.attachJob(original.scope, run.id, "graph_packages", job.id);
    await sync.updateSource(original.scope, run.id, "graph_packages", {
      status: "running", jobId: job.id, message: "Publishing synthetic source.", canRetry: false,
    });
    await expect(publish(original.scope, job.id, undefined, async client => {
      await client.query("DO $$ BEGIN RAISE EXCEPTION 'synthetic_final_publication_failure'; END $$");
    })).rejects.toThrow("synthetic_final_publication_failure");
    expect(await jobs.getJob(original.scope, job.id)).toMatchObject({ status: "running" });
    expect((await sync.getRun(original.scope, run.id))?.sources[0]).toMatchObject({ status: "running", count: null });
    expect((await sync.listMarkers(original.scope)).find(row => row.source === "graph_packages")).toMatchObject({ count: null });
    await assertOriginal(original);
    await jobs.cancel(original.scope, job.id, original.scope.principalId);
    await sync.cancel(original.scope, run.id);
  });
});
