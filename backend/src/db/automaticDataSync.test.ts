import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { DataSyncRepository, type DataSyncScope } from "./dataSync.js";
import type { DataSyncRun } from "../types/dataSync.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let repository: DataSyncRepository;
beforeAll(async () => {
  fixture = await testDatabase();
  repository = new DataSyncRepository(fixture.runtime);
});
afterAll(async () => { await fixture?.close(); });
const owner = (): DataSyncScope => ({ tenantId: randomUUID(), principalId: randomUUID() });

async function complete(scope: DataSyncScope, run: DataSyncRun) {
  for (const source of run.sources) await repository.updateSource(scope, run.id, source.source,
    { status: "succeeded", count: 0, message: "Saved empty fixture source.", canRetry: false });
}

describe("session-driven automatic sync admission", () => {
  it("atomically deduplicates across independent callers and does not request manual reports", async () => {
    const scope = owner();
    const [left, right] = await Promise.all([
      repository.submitDue(scope), new DataSyncRepository(fixture.runtime).submitDue(scope),
    ]);
    expect(left.run?.id).toBe(right.run?.id);
    expect([left.created, right.created].sort()).toEqual([false, true]);
    expect(left.run).toMatchObject({ automatic: true, mode: "incremental" });
    expect(left.run?.sources.map(source => source.source)).toEqual(["graph_packages", "power_platform", "users"]);
    expect(await repository.getRun(owner(), left.run!.id)).toBeUndefined();
    await complete(scope, left.run!);
    expect(await repository.submitDue(scope)).toMatchObject({ created: false, run: { id: left.run!.id } });
  });

  it("refreshes only sources whose saved success and latest attempt are at least 15 minutes old", async () => {
    const scope = owner();
    const first = await repository.submitDue(scope);
    await complete(scope, first.run!);
    await fixture.operator.query(`UPDATE data_sync_success_markers SET last_success_at=clock_timestamp()-interval '16 minutes'
      WHERE tenant_id=$1 AND principal_id=$2 AND source_id='graph_packages'`, [scope.tenantId, scope.principalId]);
    // A recent attempt still prevents a duplicate even when its saved timestamp is older.
    expect((await repository.submitDue(scope)).created).toBe(false);
    await fixture.operator.query(`UPDATE data_sync_run_sources SET updated_at=clock_timestamp()-interval '16 minutes'
      WHERE run_id=$1 AND source_id='graph_packages'`, [first.run!.id]);
    const next = await repository.submitDue(scope);
    expect(next).toMatchObject({ created: true, run: { sources: [{ source: "graph_packages" }] } });
    await complete(scope, next.run!);
  });

  it("backs off permission failures independently while allowing healthy source refresh", async () => {
    const scope = owner();
    const first = await repository.submitDue(scope);
    for (const source of first.run!.sources) await repository.updateSource(scope, first.run!.id, source.source,
      source.source === "users"
        ? { status: "permission_required", count: null, message: "Directory permission unavailable.", canRetry: true }
        : { status: "succeeded", count: 0, message: "Saved fixture inventory.", canRetry: false });
    await repository.finishAutomatic(scope, first.run!.id);
    expect(await repository.getRun(scope, first.run!.id)).toMatchObject({ status: "partial" });
    await fixture.operator.query(`UPDATE data_sync_run_sources SET updated_at=clock_timestamp()-interval '16 minutes'
      WHERE run_id=$1`, [first.run!.id]);
    await fixture.operator.query(`UPDATE data_sync_success_markers SET last_success_at=clock_timestamp()-interval '16 minutes'
      WHERE tenant_id=$1 AND principal_id=$2`, [scope.tenantId, scope.principalId]);
    const next = await repository.submitDue(scope);
    expect(next.run?.sources.map(source => source.source)).toEqual(["graph_packages", "power_platform"]);
    await complete(scope, next.run!);
    await fixture.operator.query(`UPDATE data_sync_run_sources SET updated_at=clock_timestamp()-interval '61 minutes'
      WHERE run_id=$1 AND source_id='users'`, [first.run!.id]);
    expect((await repository.submitDue(scope)).run?.sources.map(source => source.source)).toEqual(["users"]);
  });

  it("retries old authorization failures once after sign-in without bypassing other source cooldowns", async () => {
    const scope = owner();
    const first = await repository.submitDue(scope);
    for (const source of first.run!.sources) await repository.updateSource(scope, first.run!.id, source.source, {
      status: source.source === "graph_packages" ? "waiting_authorization"
        : source.source === "power_platform" ? "permission_required" : "succeeded",
      count: 0, message: "Fixture result.", canRetry: source.source !== "users",
    });
    await repository.finishAutomatic(scope, first.run!.id);
    await fixture.operator.query(`UPDATE data_sync_run_sources SET updated_at=clock_timestamp()-interval '1 minute'
      WHERE run_id=$1`, [first.run!.id]);
    const signedInAt = Date.now();
    expect((await repository.submitDue(scope)).created).toBe(false);
    const next = await repository.submitDue(scope, signedInAt);
    expect(next).toMatchObject({ created: true, run: { sources: [{ source: "graph_packages", status: "queued" }] } });
    await repository.updateSource(scope, next.run!.id, "graph_packages", {
      status: "waiting_authorization", message: "MFA is still required.", canRetry: true,
    });
    await repository.finishAutomatic(scope, next.run!.id);
    expect((await repository.submitDue(scope, signedInAt)).created).toBe(false);
  });

  it("does not close a live run during the child authorization handoff", async () => {
    const scope = owner();
    const first = await repository.submitDue(scope);
    for (const source of first.run!.sources) await repository.updateSource(scope, first.run!.id, source.source,
      { status: "waiting_authorization", message: "Starting authorized child work.", canRetry: true });
    const concurrent = await repository.submitDue(scope);
    expect(concurrent).toMatchObject({ created: false, run: { id: first.run!.id, status: "waiting" } });
    await repository.updateSource(scope, first.run!.id, "graph_packages",
      { status: "running", message: "Child started.", canRetry: false });
    expect(await repository.getRun(scope, first.run!.id)).toMatchObject({ status: "running" });
  });

  it("allows recovery when an old worker reports its authentication failure after sign-in completes", async () => {
    const scope = owner();
    const first = await repository.submitDue(scope);
    await repository.updateSource(scope, first.run!.id, "users",
      { status: "succeeded", count: 0, message: "Saved.", canRetry: false });
    await repository.updateSource(scope, first.run!.id, "power_platform",
      { status: "succeeded", count: 0, message: "Saved.", canRetry: false });
    const signedInAt = Date.now();
    await repository.updateSource(scope, first.run!.id, "graph_packages",
      { status: "waiting_authorization", message: "Old token request finished late.", canRetry: true });
    await repository.finishAutomatic(scope, first.run!.id);
    expect(await repository.submitDue(scope, signedInAt)).toMatchObject({
      created: true, run: { sources: [{ source: "graph_packages", status: "queued" }] },
    });
  });

  it("defers to manual work and never clears snapshots or rewrites immutable intent", async () => {
    const scope = owner();
    const manual = await repository.submit(scope, { mode: "initial" });
    expect(await repository.submitDue(scope)).toMatchObject({ created: false, run: { id: manual.run.id } });
    await repository.cancel(scope, manual.run.id);
    const automatic = await repository.submitDue(owner());
    await expect(fixture.runtime.query("UPDATE data_sync_runs SET automatic=false WHERE id=$1", [automatic.run!.id]))
      .rejects.toThrow("immutable");
    await expect(fixture.runtime.query("UPDATE data_sync_runs SET clear_saved_data=true WHERE id=$1", [automatic.run!.id]))
      .rejects.toThrow();
    expect((await fixture.runtime.query("SELECT clear_saved_data FROM data_sync_runs WHERE id=$1", [automatic.run!.id])).rows[0])
      .toEqual({ clear_saved_data: false });
  });

  it("recovers interrupted automatic work without launching anything until a signed-in due check", async () => {
    const scope = owner();
    const first = await repository.submitDue(scope);
    await repository.recoverInterrupted();
    expect(await repository.getRun(scope, first.run!.id)).toMatchObject({ status: "partial" });
    expect((await repository.submitDue(scope)).created).toBe(false);
    expect(await repository.getRun(scope, first.run!.id)).toMatchObject({ status: "partial" });
    expect(await repository.automaticRevisions(scope)).toEqual({
      users: expect.stringMatching(/^[a-f0-9]{64}$/),
      graph_packages: expect.stringMatching(/^[a-f0-9]{64}$/),
      power_platform: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });
});
