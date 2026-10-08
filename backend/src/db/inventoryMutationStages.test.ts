import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { newUsageScope, saveUsageInventory, usageAudit, usageIdentity } from "./agentUsageTestSupport.js";
import { InventoryMutationStages } from "./inventoryMutationStages.js";
import { createJobConfirmation, JobRepository } from "./jobs.js";
import { DataGenerations } from "./dataGenerations.js";
import { runBulkJob } from "../services/bulkJobs.js";
import { GraphPackagesClient, type FetchLike } from "../services/graphPackages.js";
import { capabilities } from "../services/capabilities.js";
import { inventoryInput } from "../../scripts/inventoryFixtures.js";
import { InventoryReconciliation } from "../services/inventoryReconciliation.js";
import { StreamedInventory } from "../services/streamedInventory.js";
import { assertCurrentMutationTargets } from "./inventoryMutationAuthority.js";
import { inventoryPresentation } from "../services/inventoryPresentation.js";
import { verifySchema } from "./schema.js";
import { initializeSchema } from "../../scripts/database.js";

vi.hoisted(() => { process.env.SESSION_SECRET ??= "synthetic-staged-mutation-secret-long"; });

describe("record-store mutation staging", () => {
  let fixture: Awaited<ReturnType<typeof testDatabase>>;
  let stages: InventoryMutationStages;
  beforeAll(async () => { fixture = await testDatabase(); stages = new InventoryMutationStages(fixture.runtime); });
  afterAll(async () => { await fixture?.close(); });
  afterEach(() => vi.restoreAllMocks());
  async function setup() {
    const scope = newUsageScope();
    await saveUsageInventory(fixture.runtime, scope, [{ packages: ["A", "a", "😀", "\ue000"] }, { packages: ["Blocked"], packageFields: { isBlocked: true } }]);
    const identity = await usageIdentity(fixture.runtime, scope), selectionId = await stages.currentSelection(identity);
    return { scope, identity, selectionId, intent: { ...usageAudit(scope), action: "block" as const, scope: "bulk" as const } };
  }
  it.each(["single", "bulk"] as const)("publishes %s block/unblock and skipped readbacks before the next selection and confirmation", async mutationScope => {
    const scope = newUsageScope();
    const ids = mutationScope === "single" ? ["A"] : ["A", "B"];
    await saveUsageInventory(fixture.runtime, scope, [...ids, "Untouched"].map(id => ({
      packages: [id], packageFields: { isBlocked: false, availableTo: "some", deployedTo: "some" },
    })));
    const identity = await usageIdentity(fixture.runtime, scope);
    const original = inventoryPresentation(await stages.queries.page(await stages.currentSelection(identity), identity));
    const jobs = new JobRepository(fixture.runtime);
    const blocked = new Set<string>();
    const fetcher = vi.fn<FetchLike>(async (url, request) => {
      const path = new URL(url).pathname.split("/");
      const id = decodeURIComponent(path.at(request?.method === "POST" ? -2 : -1)!);
      if (request?.method === "POST") {
        if (path.at(-1) === "block") blocked.add(id);
        else blocked.delete(id);
        return new Response(null, { status: 204 });
      }
      return Response.json({ id, displayName: `Inventory ${id}`, isBlocked: blocked.has(id) });
    });
    vi.spyOn(capabilities, "observeOperation").mockImplementation(async (_id, _user, operation) => operation(() => undefined));
    const provider = new GraphPackagesClient(fetcher, { minimumReadIntervalMs: 0, maxAttempts: 1 });
    for (const [action, skipped] of [["block", false], ["block", true], ["unblock", false], ["unblock", true]] as const) {
      const selectionId = await stages.currentSelection(identity);
      const intent = { ...usageAudit(scope), action, scope: mutationScope };
      const preview = await stages.preview(identity, selectionId, intent, ids);
      const job = await stages.submit(identity, {
        ...intent, ids, confirmationHash: preview.confirmationHash, idempotencyKey: randomUUID(),
      });
      await runBulkJob(job.id, scope, false, jobs, provider, async () => "synthetic");
      expect(await jobs.get(job.id, scope)).toMatchObject({
        status: "succeeded", succeeded: skipped ? 0 : ids.length, skipped: skipped ? ids.length : 0,
      });
      expect((await fixture.runtime.query(`SELECT count(*)::int AS count FROM inventory_control_pending
        WHERE tenant_id=$1 AND principal_id=$2`, [scope.tenantId, scope.principalId])).rows[0].count).toBe(0);
      const page = inventoryPresentation(await stages.queries.page(await stages.currentSelection(identity), identity));
      expect(page.value.map(record => record.id).sort()).toEqual(original.value.map(record => record.id).sort());
      for (const item of page.value.flatMap(record => record.packages)) {
        expect(item).toMatchObject({
          isBlocked: ids.includes(item.id) && action === "block", availableTo: "some", deployedTo: "some",
        });
      }
    }
    expect(fetcher.mock.calls.filter(([, request]) => request?.method === "POST")).toHaveLength(ids.length * 2);
  });

  it("acceptance: durable authority survives preview cleanup and preserves an unchanged qualified provider write", async () => {
    const { scope, identity, selectionId, intent } = await setup();
    const preview = await stages.preview(identity, selectionId, { ...intent, scope: "single" }, ["A"]);
    const job = await stages.submit(identity, { ...intent, scope: "single", selectionId, ids: ["A"],
      confirmationHash: preview.confirmationHash, idempotencyKey: randomUUID() });
    await expect(verifySchema(fixture.runtime)).resolves.toBeUndefined();
    await expect(initializeSchema(fixture.operator)).resolves.toBeUndefined();
    await expect(fixture.runtime.query("UPDATE job_items SET source_identity='changed' WHERE job_id=$1", [job.id]))
      .rejects.toThrow("job inventory authority is immutable");
    await expect(fixture.runtime.query(`UPDATE job_items SET source_generation_id=NULL,source_identity=NULL,
      agent_id=NULL,authority_expires_at=NULL WHERE job_id=$1`, [job.id]))
      .rejects.toThrow("job inventory authority is immutable");
    await fixture.runtime.query("DELETE FROM inventory_mutation_stages WHERE selection_id=$1", [selectionId]);
    await fixture.runtime.query("DELETE FROM data_generation_pins WHERE selection_id=$1", [selectionId]);
    await fixture.runtime.query("DELETE FROM inventory_read_contexts WHERE selection_id=$1", [selectionId]);
    await fixture.runtime.query("DELETE FROM data_read_selections WHERE id=$1", [selectionId]);
    expect((await fixture.runtime.query("SELECT id FROM inventory_mutation_stages WHERE id=$1", [preview.stageId])).rowCount).toBe(0);
    let mutations = 0;
    const fetcher: FetchLike = async (_url, request) => {
      if (request?.method === "POST") { mutations++; return new Response(null, { status: 204 }); }
      return Response.json({ id: "A", displayName: "Inventory A", isBlocked: mutations > 0 });
    };
    vi.spyOn(capabilities, "observeOperation").mockImplementation(async (_id, _user, operation) => operation(() => undefined));
    const jobs = new JobRepository(fixture.runtime);
    await runBulkJob(job.id, scope, false, jobs,
      new GraphPackagesClient(fetcher, { minimumReadIntervalMs: 0, maxAttempts: 1 }), async () => "synthetic");
    expect(mutations).toBe(1);
    expect(await jobs.get(job.id, scope)).toMatchObject({ status: "succeeded", succeeded: 1 });
  });
  it.each(["replacement", "withdrawal", "invalidation", "principal"] as const)(
    "acceptance: rechecks %s at the final real staged provider dispatch", async change => {
      const { scope, identity, selectionId, intent } = await setup();
      const preview = await stages.preview(identity, selectionId, intent, ["A"]);
      const job = await stages.submit(identity, { ...intent, selectionId, ids: ["A"],
        confirmationHash: preview.confirmationHash, idempotencyKey: randomUUID() });
      let reads = 0, mutations = 0;
      const fetcher: FetchLike = async (_url, request) => {
        if (request?.method === "POST") { mutations++; return new Response(null, { status: 204 }); }
        if (++reads === 2) {
          if (change === "principal") await new DataGenerations(fixture.runtime).revokePrincipal(scope.tenantId, scope.principalId);
          else if (change === "invalidation") {
            const source = (await fixture.runtime.query(`SELECT id FROM data_scope_epochs WHERE tenant_id=$1
              AND principal_id=$2 AND source='inventory_packages'`, [scope.tenantId, scope.principalId])).rows[0];
            await new DataGenerations(fixture.runtime).invalidate(source.id, scope.tenantId);
          } else await saveUsageInventory(fixture.runtime, scope, [{ packages: [change === "replacement" ? "A" : "Other"] }]);
        }
        return Response.json({ id: "A", displayName: "Inventory A", isBlocked: mutations > 0 });
      };
      vi.spyOn(capabilities, "observeOperation").mockImplementation(async (_id, _user, operation) => operation(() => undefined));
      await runBulkJob(job.id, scope, false, new JobRepository(fixture.runtime),
        new GraphPackagesClient(fetcher, { minimumReadIntervalMs: 0, maxAttempts: 1 }), async () => "synthetic");
      expect(mutations).toBe(0);
      expect(reads).toBe(2);
      expect((await fixture.runtime.query(`SELECT status,sent_at,error_code FROM job_items WHERE job_id=$1`, [job.id])).rows)
        .toEqual([{ status: "failed", sent_at: null, error_code: "confirmation_mismatch" }]);
      expect((await fixture.runtime.query(`SELECT status,error_code FROM audit_events WHERE operation_id=$1
        AND status<>'requested' ORDER BY observed_at`, [job.id])).rows).toEqual([
          { status: "started", error_code: null }, { status: "failed", error_code: "confirmation_mismatch" },
        ]);
    });

  it("acceptance: expired optional identity rejects stage, preview, submission and dispatch but preserves catalog reads", async () => {
    const scope = newUsageScope(), expiresAt = new Date(Date.now() + 2_000);
    const input = inventoryInput(scope.principalId);
    input.scope.tenantId = scope.tenantId;
    input.observedAt = new Date(expiresAt.getTime() - 3_600_001);
    const value = { id: "aging", displayName: "Aging", isBlocked: false, version: "1",
      lastModifiedDateTime: input.observedAt.toISOString(),
      elementDetails: [{ elementType: "DeclarativeCopilots", elements: [{ id: "identity", definition: "{}" }] }] };
    const stream = new StreamedInventory(fixture.runtime, new GraphPackagesClient(async url =>
      Response.json(new URL(url).pathname.endsWith("/aging") ? value : { value: [value] }), { minimumReadIntervalMs: 0, maxAttempts: 1 }));
    await stream.graphCatalog(input, "synthetic", { authorize: async () => {} });
    const source = await stream.details({ ...input, jobId: randomUUID(), observedAt: new Date(expiresAt.getTime() - 3_600_000) },
      "synthetic", ["aging"], { authorize: async () => {} });
    const canonical = inventoryInput(scope.principalId, "canonical");
    canonical.scope.tenantId = scope.tenantId;
    const reconciliation = new InventoryReconciliation(fixture.runtime);
    await reconciliation.request(canonical, [source]);
    await reconciliation.runNext(canonical, async () => {});
    const identity = await usageIdentity(fixture.runtime, scope), selectionId = await stages.currentSelection(identity);
    const initiallyReadable = inventoryPresentation(await stages.queries.page(selectionId, identity));
    expect(initiallyReadable.value[0].packages[0].detailFreshness?.state).toBe("fresh");
    expect(initiallyReadable.value[0].observations.packageSnapshots.aging.identityDetails?.current).toBe(true);
    const intent = { ...usageAudit(scope), action: "block" as const, scope: "single" as const };
    const preview = await stages.preview(identity, selectionId, intent, ["aging"]);
    const job = await stages.submit(identity, { ...intent, selectionId, ids: ["aging"],
      confirmationHash: preview.confirmationHash, idempotencyKey: randomUUID() });
    let reads = 0, mutations = 0;
    let expiryChecks: unknown[] = [];
    let retained: ReturnType<typeof inventoryPresentation> | undefined;
    const fetcher: FetchLike = async (_url, request) => {
      if (request?.method === "POST") { mutations++; return new Response(null, { status: 204 }); }
      if (++reads === 2) {
        await expect.poll(() => Date.now() >= expiresAt.getTime(), { timeout: 3_000, interval: 20 }).toBe(true);
        const client = await fixture.runtime.connect();
        try {
          expiryChecks = await Promise.allSettled([
            assertCurrentMutationTargets(client, identity, preview.stageId, 1),
            stages.queries.withCurrentSelection(selectionId, identity, async () => true),
            stages.preview(identity, selectionId, intent, ["aging"]),
            stages.submit(identity, { ...intent, selectionId, ids: ["aging"], confirmationHash: preview.confirmationHash,
              idempotencyKey: randomUUID() }),
          ]);
        } finally { client.release(); }
        retained = inventoryPresentation(await stages.queries.page(selectionId, identity));
      }
      return Response.json({ id: "aging", displayName: "Aging", isBlocked: mutations > 0 });
    };
    vi.spyOn(capabilities, "observeOperation").mockImplementation(async (_id, _user, operation) => operation(() => undefined));
    await runBulkJob(job.id, scope, false, new JobRepository(fixture.runtime),
      new GraphPackagesClient(fetcher, { minimumReadIntervalMs: 0, maxAttempts: 1 }), async () => "synthetic");
    expect.soft(mutations).toBe(0);
    expect(expiryChecks).toMatchObject([
      { status: "rejected", reason: { code: "confirmation_mismatch" } },
      ...Array.from({ length: 3 }, () => ({ status: "rejected", reason: { code: "selection_invalidated" } })),
    ]);
    expect(retained!.value).toHaveLength(1);
    const currentRead = await stages.currentSelection(identity);
    const page = inventoryPresentation(await stages.queries.page(currentRead, identity));
    expect(page.value[0].packages[0].detailFreshness?.state).toBe("stale");
    expect(page.value[0].observations.packageSnapshots.aging.identityDetails?.current).toBe(false);
  });
  it("acceptance: a staged multi-target job settles its own readbacks without rebinding the remaining source targets", async () => {
    const scope = newUsageScope(), input = inventoryInput(scope.principalId);
    input.scope.tenantId = scope.tenantId;
    const blocked = new Set<string>();
    const packages = ["first", "second"].map(id => ({ id, displayName: id, isBlocked: false }));
    const fetcher: FetchLike = async (url, request) => {
      const id = decodeURIComponent(new URL(url).pathname.split("/").at(request?.method === "POST" ? -2 : -1)!);
      if (request?.method === "POST") { blocked.add(id); return new Response(null, { status: 204 }); }
      return Response.json(id === "packages" ? { value: packages } : { id, displayName: id, isBlocked: blocked.has(id) });
    };
    const graph = new GraphPackagesClient(fetcher, { minimumReadIntervalMs: 0, maxAttempts: 1 });
    const source = await new StreamedInventory(fixture.runtime, graph).graphCatalog(input, "synthetic", { authorize: async () => {} });
    const canonical = inventoryInput(scope.principalId, "canonical");
    canonical.scope.tenantId = scope.tenantId;
    const reconciliation = new InventoryReconciliation(fixture.runtime);
    await reconciliation.request(canonical, [source]);
    await reconciliation.runNext(canonical, async () => {});
    const identity = await usageIdentity(fixture.runtime, scope), selectionId = await stages.currentSelection(identity);
    const intent = { ...usageAudit(scope), action: "block" as const, scope: "bulk" as const };
    const ids = packages.map(row => row.id), preview = await stages.preview(identity, selectionId, intent, ids);
    const job = await stages.submit(identity, { ...intent, selectionId, ids, confirmationHash: preview.confirmationHash,
      idempotencyKey: randomUUID() });
    vi.spyOn(capabilities, "observeOperation").mockImplementation(async (_id, _user, operation) => operation(() => undefined));
    const jobs = new JobRepository(fixture.runtime);
    await runBulkJob(job.id, scope, false, jobs, graph, async () => "synthetic");
    expect([...blocked]).toEqual(ids);
    expect(await jobs.get(job.id, scope)).toMatchObject({ status: "succeeded", succeeded: 2 });
  });
  it("retains the confirmation digest while staging exact opaque targets and creating only scalar job metadata", async () => {
    const { scope, identity, selectionId, intent } = await setup();
    const preview = await stages.preview(identity, selectionId, intent, ["😀", "\ue000", "a", "A"]);
    const expected = createJobConfirmation({ ...intent, targets: ["😀", "\ue000", "a", "A"].map(id =>
      ({ id, displayName: `Inventory ${id}`, prestate: { kind: "block" as const, isBlocked: false } })) });
    expect(preview).toMatchObject({ confirmationHash: expected.confirmationHash, summary: expected.summary });
    const idempotencyKey = randomUUID(), requestPath = "/agents/block";
    const job = await stages.submit(identity, { ...intent, selectionId, ids: ["A", "a", "\ue000", "😀"], confirmationHash: preview.confirmationHash,
      idempotencyKey, requestPath });
    expect(job).toMatchObject({ status: "queued", total: 4, completed: 0 });
    expect(job).not.toHaveProperty("results");
    expect(job).not.toHaveProperty("result");
    const jobs = new JobRepository(fixture.runtime);
    await expect(jobs.getByIdempotency(scope, "graph.package.block.manage", idempotencyKey,
      { action: "block", requestPath, scope: "bulk", targetIds: ["😀", "\ue000", "a", "A"] })).resolves.toMatchObject({ id: job.id });
    await expect(jobs.getByIdempotency(scope, "graph.package.block.manage", idempotencyKey,
      { action: "block", requestPath, scope: "bulk", targetIds: ["A", "Blocked"] })).rejects.toMatchObject({ code: "idempotency_mismatch" });
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM audit_events WHERE operation_id=$1", [job.id])).rows[0].count).toBe(4);
  });
  it("selects filtered targets entirely in SQL and refuses exact IDs outside that selection", async () => {
    const { identity, intent } = await setup();
    const root = (await fixture.runtime.query(`SELECT id FROM data_scope_epochs WHERE tenant_id=$1 AND principal_id=$2
      AND source='inventory_canonical'`, [identity.tenantId, identity.principalId])).rows[0];
    const selected = await stages.queries.capture(identity, root.id, { blocked: true });
    const preview = await stages.preview(identity, selected.id, { ...intent, action: "unblock" });
    expect(preview.summary).toMatchObject({ targetCount: 1, targets: [{ id: "Blocked", currentState: { kind: "block", isBlocked: true } }] });
    await expect(stages.preview(identity, selected.id, intent, ["A"])).rejects.toMatchObject({ code: "package_target_stale_or_absent" });
    await expect(stages.submit(identity, { ...intent, action: "unblock", confirmationHash: preview.confirmationHash,
      selectionId: selected.id, idempotencyKey: randomUUID(), ids: ["A"] })).rejects.toMatchObject({ code: "confirmation_mismatch" });
  });
  it("keeps ready intent and prestates immutable and fences refresh, invalidation and foreign actors", async () => {
    const { scope, identity, selectionId, intent } = await setup();
    const preview = await stages.preview(identity, selectionId, intent, ["A"]);
    await expect(fixture.runtime.query("UPDATE inventory_mutation_targets SET prestate='{}' WHERE stage_id=$1", [preview.stageId]))
      .rejects.toThrow("mutation target is immutable");
    await expect(fixture.runtime.query("UPDATE inventory_mutation_stages SET target_count=2 WHERE id=$1", [preview.stageId]))
      .rejects.toThrow("mutation confirmation is immutable");
    await expect(stages.submit({ ...identity, principalId: "foreign" }, { ...intent,
      confirmationHash: preview.confirmationHash, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "confirmation_mismatch" });
    const source = (await fixture.runtime.query(`SELECT id FROM data_scope_epochs WHERE tenant_id=$1 AND principal_id=$2
      AND source='inventory_packages'`, [scope.tenantId, scope.principalId])).rows[0];
    await new DataGenerations(fixture.runtime).invalidate(source.id, scope.tenantId);
    await expect(stages.submit(identity, { ...intent, confirmationHash: preview.confirmationHash,
      ids: ["A"], idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "selection_invalidated" });
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM jobs WHERE tenant_id=$1", [scope.tenantId])).rows[0].count).toBe(0);
  });
  it("expands exact logical groups in SQL and binds the complete selection criteria to confirmation", async () => {
    const { identity, selectionId, intent } = await setup();
    const page = await stages.queries.page(selectionId, identity);
    const group = page.value.find(row => row.members.some(member => member.native_id === "A"))!;
    expect(group.members.filter(member => member.domain === "packages")).toHaveLength(1);
    expect(group.members.find(member => member.domain === "packages")?.total).toBe("4");
    const recordIds = [`agent:${group.id}`];
    expect(await stages.count(identity, selectionId, ["A"], recordIds)).toEqual({ count: 4 });
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM inventory_mutation_stages WHERE principal_id=$1",
      [identity.principalId])).rows[0].count).toBe(0);
    const preview = await stages.preview(identity, selectionId, intent, undefined, recordIds);
    expect(preview.summary.targetCount).toBe(4);
    expect(new Set(preview.summary.targets.map(target => target.id))).toEqual(new Set(["A", "a", "😀", "\ue000"]));
    await expect(fixture.runtime.query("UPDATE inventory_mutation_stages SET target_filter_hash=repeat('a',64) WHERE id=$1", [preview.stageId]))
      .rejects.toThrow("mutation confirmation is immutable");
    await expect(stages.submit(identity, { ...intent, selectionId, confirmationHash: preview.confirmationHash, idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ code: "confirmation_mismatch" });
    await expect(stages.submit(identity, { ...intent, selectionId, recordIds, confirmationHash: preview.confirmationHash, idempotencyKey: randomUUID() }))
      .resolves.toMatchObject({ total: 4, queued: 4 });
  });
});
