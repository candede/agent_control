import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { retain } from "../../scripts/database.js";
import { inventoryInput, inventorySelectionFixture, reconcileInventoryFixture } from "../../scripts/inventoryFixtures.js";
import { selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import { testDatabase } from "../../scripts/testDatabase.js";
import { completeInventoryJob, inventoryJobInput } from "../services/inventoryRuntime.js";
import { inventoryPresentation, inventorySourceStatuses } from "../services/inventoryPresentation.js";
import { powerPlatformInventoryRecord } from "../services/inventoryRecordProjection.js";
import { PowerPlatformResourceQueryClient } from "../services/powerPlatformResourceQuery.js";
import { StreamedInventory } from "../services/streamedInventory.js";
import { inventoryQueryTypes } from "../services/inventoryRoleScope.js";
import { powerPlatformResourceTypes, type InventoryRoleScope, type PowerPlatformResourceType } from "../types/powerPlatformInventory.js";
import { DataGenerations } from "./dataGenerations.js";
import { InventoryGenerations, inventorySelector } from "./inventoryGenerations.js";
import { InventoryQueries, type InventoryQuery } from "./inventoryQueries.js";
import { InventoryIdentityQueries } from "./inventoryIdentityQueries.js";
import { PowerPlatformRefreshJobs, type InventoryDataScope } from "./powerPlatformRefreshJobs.js";
import { checkpointQueries, observePeakMemory, observeQueryWork } from "../services/peakMemory.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let jobs: PowerPlatformRefreshJobs;
const agentType = "microsoft.copilotstudio/agents";
const environmentType = "microsoft.powerplatform/environments";
const environmentId = "11111111-1111-4111-8111-111111111111";
const selections: Array<{ queries: InventoryQueries; identity: typeof selectionIdentity; selection: { id: string } }> = [];
type ProviderRow = { name: string; tenantId: string; type: PowerPlatformResourceType; properties: Record<string, unknown> };
type Root = Awaited<ReturnType<StreamedInventory["powerPlatformCatalog"]>>;
type Fetcher = ConstructorParameters<typeof PowerPlatformResourceQueryClient>[0];
beforeAll(async () => { fixture = await testDatabase(); jobs = new PowerPlatformRefreshJobs(fixture.runtime); });
afterEach(async () => {
  for (const selected of selections.splice(0)) await selected.queries.selections.invalidate(selected.selection.id, selected.identity);
});
afterAll(async () => { await fixture?.close(); });
const owner = (): InventoryDataScope => ({ tenantId: `native-${randomUUID()}`, principalId: "reader" });
const resource = (scope: InventoryDataScope, name: string, properties: Record<string, unknown> = {},
  type: PowerPlatformResourceType = agentType): ProviderRow => ({
  name, tenantId: scope.tenantId, type, properties: { displayName: name, ...type === agentType ? { environmentId } : {}, ...properties },
});
function provider(values: ProviderRow[], expectedCount = values.length, pageSize = 100): Fetcher {
  if (values.length > 100) throw new Error("tiny_native_provider_fixture_limit");
  return async (_url, init) => {
    const { Options: options } = JSON.parse(String(init?.body));
    const offset = Number(options.SkipToken ?? 0);
    const rows = values.slice(offset, offset + pageSize);
    return Response.json({ data: rows, totalRecords: expectedCount, count: rows.length, resultTruncated: 1,
      ...offset + pageSize < values.length ? { skipToken: String(offset + pageSize) } : {} });
  };
}
async function running(scope: InventoryDataScope, key: string, types: readonly PowerPlatformResourceType[] = powerPlatformResourceTypes,
  roleScope: InventoryRoleScope = "full", environmentScope?: string) {
  const job = await jobs.submit(scope, { idempotencyKey: key, requestedTypes: types, roleScope, environmentScope });
  expect(await jobs.markRunning(scope, job.id)).toBe(true);
  return job;
}
async function collect(scope: InventoryDataScope, job: Awaited<ReturnType<typeof running>>, fetcher: Fetcher,
  options: { expiresAt?: Date; beforeComplete?: () => Promise<void>; signal?: AbortSignal;
    onProgress?: (pages: number) => void } = {}) {
  const input = await inventoryJobInput(fixture.runtime, scope, "power_platform", job.id,
    { resourceTypes: job.requestedTypes, environmentId: job.environmentScope ?? undefined });
  if (options.expiresAt) input.expiresAt = options.expiresAt;
  const stream = new StreamedInventory(fixture.runtime, undefined, new PowerPlatformResourceQueryClient(fetcher, { maxAttempts: 1 }));
  return stream.powerPlatformCatalog(input, "synthetic-token", job.requestedTypes, {
    roleScope: job.roleScope, environmentId: job.environmentScope ?? undefined, authorize: async () => {}, signal: options.signal,
    onProgress: async progress => {
      await jobs.recordProgress(scope, job.id, progress.pages, progress.observedCount, progress.totalRecords);
      options.onProgress?.(progress.pages);
    },
    completeJob: async (client, result) => { await options.beforeComplete?.(); await completeInventoryJob(input, "power_platform")(client, result); },
  });
}
async function selected(scope: InventoryDataScope, root: Root, query: InventoryQuery = {}) {
  const queries = new InventoryQueries(fixture.runtime, "synthetic-native-selected-cursor-key-32");
  const identity = { ...selectionIdentity, ...scope, sessionEpoch: await new DataGenerations(fixture.runtime).sessionEpoch(scope.tenantId, scope.principalId) };
  const selection = await queries.capture(identity, root.scopeId, query);
  selections.push({ queries, identity, selection });
  const raw = await queries.page(selection.id, identity, { limit: 100 });
  return { queries, identity, selection, raw };
}
async function canonical(scope: InventoryDataScope) {
  await reconcileInventoryFixture(fixture.runtime, scope);
  const value = await inventorySelectionFixture(fixture.runtime, scope);
  selections.push(value);
  return { ...value, page: inventoryPresentation(value.raw) };
}

describe.sequential("streamed native inventory and durable refresh jobs", () => {
  it("retains cancellation ownership and internal cleanup provenance", async () => {
    const scope = owner();
    const job = await jobs.submit(scope, { idempotencyKey: "cancel", requestedTypes: [agentType], roleScope: "full" });
    expect(await jobs.cancel({ ...scope, principalId: "other-reader" }, job.id)).toBeUndefined();
    await jobs.cancel(scope, job.id, "sync_cleanup");
    await jobs.cancel(scope, job.id);
    expect(await jobs.getJob(scope, job.id)).toMatchObject({ status: "cancelled", errorCode: "data_sync_cleanup",
      message: expect.stringContaining("original failure or interruption") });
  });

  it("projects recognized provider authoring metadata while preserving immutable raw evidence", async () => {
    const scope = owner(), job = await running(scope, "authoring", [agentType]);
    const root = await collect(scope, job, provider([resource(scope, "lite", { createdIn: "Copilot Studio Lite" })]));
    const page = (await canonical(scope)).page;
    expect(page.value[0].powerPlatformResource).toMatchObject({
      authoringTool: "Microsoft 365 Copilot Agent Builder", details: { createdIn: "Copilot Studio Lite" },
      provenance: { authoringTool: { path: "properties.createdIn" } },
    });
    expect((await fixture.runtime.query(`SELECT residual->'details'->>'createdIn' AS raw FROM power_platform_record_rows
      WHERE generation_id=$1`, [root.baselineId])).rows).toEqual([{ raw: "Copilot Studio Lite" }]);
    await expect(fixture.operator.query(`UPDATE power_platform_record_rows SET residual='{}' WHERE generation_id=$1`,
      [root.baselineId])).rejects.toThrow("data_record_immutable");
  });

  it("joins selected environment context without including environments in canonical agent counts or leaking another owner", async () => {
    const scope = owner();
    await collect(scope, await running(scope, "environments", [environmentType]), provider([
      resource(scope, environmentId, { displayName: "Finance production", isManaged: false,
        environmentType: "Production", environmentGroup: "Finance", environmentGroupId: "group-a" }, environmentType),
    ]));
    await collect(scope, await running(scope, "agents", [agentType]), provider([resource(scope, "agent-a")]));
    const other = { ...scope, principalId: "another-reader" };
    await collect(other, await running(other, "private", [environmentType]), provider([
      resource(other, environmentId, { displayName: "Another owner's environment" }, environmentType),
    ]));
    const result = await canonical(scope);
    expect(result.page.counts).toMatchObject({ total: 1, filtered: 1 });
    expect(result.page.value[0].environment).toMatchObject({ id: environmentId, displayName: "Finance production",
      environmentType: "Production", isManaged: false, groupName: "Finance", groupId: "group-a" });
    expect(JSON.stringify(result.page)).not.toContain("Another owner's environment");
    await expect(result.queries.page(result.selection.id, { ...result.identity, principalId: "unknown-reader" }))
      .rejects.toMatchObject({ code: "selection_invalidated" });
  });

  it("publishes complete provider pages with private scope applied before SQL counts and keysets", async () => {
    const scope = owner(), job = await running(scope, "pages");
    const root = await collect(scope, job, provider([resource(scope, "agent-b"), resource(scope, "agent-a")], 2, 1));
    const result = await selected(scope, root, { search: "agent", sortBy: "displayName" });
    const first = await result.queries.page(result.selection.id, result.identity, { limit: 1 });
    expect(first.counts).toMatchObject({ total: 2, filtered: 2 });
    expect(first.value.map(row => row.nativeId)).toEqual(["agent-a"]);
    expect(first.page.nextCursor).toEqual(expect.any(String));
    expect(inventorySourceStatuses(first.freshness.sources).powerPlatform.observation).toMatchObject({
      observedCount: 2, pageCount: 2, coveredCount: 2, verification: { storedCount: 2, uniqueIdentityCount: 2 },
    });
    expect(await jobs.getJob(scope, job.id)).toMatchObject({ status: "succeeded", snapshotId: root.baselineId, observedCount: 2 });
    expect((await jobs.listJobs({ ...scope, principalId: "other-reader" })).value).toEqual([]);
    await expect(result.queries.capture({ ...result.identity, tenantId: "different-tenant" }, root.scopeId))
      .rejects.toMatchObject({ code: "selection_invalidated" });
  });

  it("retains historical broad pins while the newer complete agent query becomes current canonical truth", async () => {
    const scope = owner();
    const broad = await collect(scope, await running(scope, "broad"), provider([
      resource(scope, "old-agent"), resource(scope, environmentId, { displayName: "Saved environment" }, environmentType),
    ]));
    const pin = await selected(scope, broad);
    const next = await collect(scope, await running(scope, "agents", [agentType]), provider([resource(scope, "new-agent")]));
    expect((await selected(scope, next)).raw.value.map(row => row.nativeId)).toEqual(["new-agent"]);
    expect((await pin.queries.page(pin.selection.id, pin.identity)).counts.total).toBe(2);
    const current = await canonical(scope);
    expect(current.page.value.map(row => row.powerPlatformResource?.nativeId)).toEqual(["new-agent"]);
    expect(current.page.value[0].environment?.displayName).toBe("Saved environment");
  });

  it("orders duplicate display and native values using the complete scoped tuple without counting environment rows as agents", async () => {
    const scope = owner();
    await collect(scope, await running(scope, "ties"), provider([
      resource(scope, "same", { displayName: "Tie", environmentId: "22222222-2222-4222-8222-222222222222" }),
      resource(scope, "same", { displayName: "Tie", environmentId }),
      resource(scope, environmentId, { displayName: "Tie" }, environmentType),
    ]));
    const result = await canonical(scope);
    const first = await result.queries.page(result.selection.id, result.identity, { limit: 1 });
    const second = await result.queries.page(result.selection.id, result.identity, { limit: 1, cursor: first.page.nextCursor! });
    const previous = await result.queries.page(result.selection.id, result.identity, { limit: 1, cursor: second.page.previousCursor! });
    expect(first.counts.total).toBe(2);
    expect(second.counts.total).toBe(2);
    expect(new Set([...first.value, ...second.value].map(row => row.environmentId)).size).toBe(2);
    expect(previous.value).toEqual(first.value);
    expect(inventorySourceStatuses(first.freshness.sources).powerPlatform.observation)
      .toMatchObject({ observedCount: 3, coveredCount: 2 });
  });

  it("atomically commits source head and job success, preserves historical pins and rolls both back on completion failure", async () => {
    const scope = owner(), firstJob = await running(scope, "initial", [agentType]);
    const firstRoot = await collect(scope, firstJob, provider([resource(scope, "old-visible")]));
    const pin = await selected(scope, firstRoot);
    let entering!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { entering = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const nextJob = await running(scope, "next", [agentType]);
    const pending = collect(scope, nextJob, provider([resource(scope, "new-visible")]),
      { beforeComplete: async () => { entering(); await held; } });
    try {
      await entered;
      expect((await fixture.runtime.query(`SELECT r.native_id FROM inventory_roots root
        JOIN inventory_memberships m ON m.baseline_id=root.baseline_id AND m.valid_from_revision<=root.revision
          AND (m.valid_to_revision IS NULL OR m.valid_to_revision>root.revision)
        JOIN power_platform_record_rows r ON r.generation_id=m.generation_id AND r.identity=m.identity
        WHERE root.scope_id=$1 AND root.current`, [firstRoot.scopeId])).rows).toEqual([{ native_id: "old-visible" }]);
      expect(await jobs.getJob(scope, nextJob.id)).toMatchObject({ status: "running", snapshotId: null });
    } finally { release(); }
    const nextRoot = await pending;
    expect((await pin.queries.page(pin.selection.id, pin.identity)).value.map(row => row.nativeId)).toEqual(["old-visible"]);
    expect((await selected(scope, nextRoot)).raw.value.map(row => row.nativeId)).toEqual(["new-visible"]);
    const failed = await running(scope, "rollback", [agentType]);
    await expect(collect(scope, failed, provider([resource(scope, "rollback-new")]),
      { beforeComplete: async () => { throw new Error("synthetic completion rollback"); } })).rejects.toThrow("synthetic completion rollback");
    expect((await selected(scope, nextRoot)).raw.value.map(row => row.nativeId)).toEqual(["new-visible"]);
    expect((await fixture.runtime.query("SELECT baseline_id FROM inventory_roots WHERE scope_id=$1 AND current",
      [nextRoot.scopeId])).rows).toEqual([{ baseline_id: nextRoot.baselineId }]);
    expect((await jobs.getJob(scope, failed.id))?.snapshotId).toBeNull();
  });

  it("rejects publication after job cancellation, expiry, scope mismatch and incomplete provider enumeration", async () => {
    const scope = owner(), first = await running(scope, "good", [agentType]);
    const root = await collect(scope, first, provider([resource(scope, "retained")]));
    const cancelled = await running(scope, "cancelled", [agentType]);
    const cancelledProvider = provider([resource(scope, "cancelled")]);
    await expect(collect(scope, cancelled, async (url, init) => {
      await jobs.cancel(scope, cancelled.id);
      return cancelledProvider!(url, init);
    })).rejects.toThrow();
    expect(await jobs.getJob(scope, cancelled.id)).toMatchObject({ status: "cancelled", snapshotId: null });
    const expired = await running(scope, "expired", [agentType]);
    await fixture.runtime.query("UPDATE power_platform_refresh_jobs SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expired.id]);
    await expect(collect(scope, expired, provider([]))).rejects.toMatchObject({ code: "inventory_job_fenced" });
    const mismatch = await running(scope, "mismatch", [agentType]);
    await expect(collect(scope, mismatch, provider([resource({ ...scope, tenantId: "other-tenant" }, "wrong")]))).rejects.toMatchObject({ code: "provider_schema" });
    expect((await jobs.getJob(scope, mismatch.id))?.snapshotId).toBeNull();
    await jobs.markWaitingAuthorization(scope, mismatch.id);
    expect(await jobs.getJob(scope, mismatch.id)).toMatchObject({ status: "waiting_authorization", errorCode: "interaction_required" });
    const incomplete = await running(scope, "incomplete", [agentType], "unknown");
    await expect(collect(scope, incomplete, provider([resource(scope, "partial-a"), resource(scope, "partial-b")], 3, 1)))
      .rejects.toMatchObject({ code: "provider_schema" });
    expect((await selected(scope, root)).raw.value.map(row => row.nativeId)).toEqual(["retained"]);
    await jobs.markFailed(scope, incomplete.id, "provider_error", "The provider query failed.");
    expect(await jobs.getJob(scope, incomplete.id)).toMatchObject({ status: "failed", observedCount: 1, totalRecords: 3, pageCount: 1 });
  });

  it.each([["retained"], ["replacement-a", "replacement-b"], []])(
    "verifies changed or empty complete authorized enumeration independently of missing role hints (%j)", async (...names) => {
      const values = names as string[], scope = owner();
      const initial = await collect(scope, await running(scope, "initial", powerPlatformResourceTypes, "unknown"),
        provider([resource(scope, "retained"), resource(scope, "removed")]));
      const pin = await selected(scope, initial);
      const job = await running(scope, "next", powerPlatformResourceTypes, "unknown");
      const next = await collect(scope, job, provider(values.map(name => resource(scope, name))));
      const page = (await selected(scope, next)).raw;
      expect(page.value.map(row => row.nativeId)).toEqual(values);
      expect(page.counts.total).toBe(values.length);
      expect(inventorySourceStatuses(page.freshness.sources).powerPlatform.observation).toMatchObject({
        roleScope: "unknown", coverage: "covered", verification: { storedCount: values.length, uniqueIdentityCount: values.length },
      });
      expect((await pin.queries.page(pin.selection.id, pin.identity)).counts.total).toBe(2);
      expect(await jobs.getJob(scope, job.id)).toMatchObject({ status: "succeeded", observedCount: values.length });
    });

  it("keeps unrequested types distinct from verified empty sources without deriving provider scope from a role hint", async () => {
    expect(inventoryQueryTypes("ai", powerPlatformResourceTypes)).toEqual(powerPlatformResourceTypes);
    const scope = owner();
    const empty = await collect(scope, await running(scope, "empty"), provider([]));
    expect(inventorySourceStatuses((await selected(scope, empty)).raw.freshness.sources).powerPlatform.observation)
      .toMatchObject({ coverage: "covered", coveredCount: 0, verification: { queriedTypes: expect.arrayContaining(powerPlatformResourceTypes) } });
    const environments = await collect(scope, await running(scope, "environments", [environmentType]), provider([]));
    expect(inventorySourceStatuses((await selected(scope, environments)).raw.freshness.sources).powerPlatform)
      .toMatchObject({ state: "partial", observation: { coverage: "not_requested", coveredCount: null,
        verification: { queriedTypes: [environmentType] } } });
  });

  it("resolves identifiers against all current authorized records, not a filtered page or another principal", async () => {
    const scope = owner(), shared = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const values = (partition: InventoryDataScope, names: string[]) => names.map(name => resource(partition, name, { entraAgentId: shared }));
    const other = { ...scope, principalId: "private" };
    await collect(other, await running(other, "private", [agentType]), provider(values(other, ["private-collision"])));
    const root = await collect(scope, await running(scope, "visible", [agentType]), provider(values(scope, ["visible-a", "visible-b"])));
    const selectedPage = await selected(scope, root, { search: "visible-a" });
    expect(selectedPage.raw.counts.filtered).toBe(1);
    const queries = new InventoryIdentityQueries(fixture.runtime);
    const resolution = await queries.read(client => queries.resolve(client, scope, [agentType], {
      tenantId: scope.tenantId, nativeId: "input", environmentId, resourceType: agentType, sourceSystem: "power_platform",
      identifiers: [{ kind: "entra_agent_id", value: shared }],
    }));
    expect(resolution).toMatchObject({ status: "ambiguous", candidates: [{ nativeId: "visible-a" }, { nativeId: "visible-b" }] });
    expect(JSON.stringify(resolution)).not.toContain("private-collision");
  });

  it("retains source success independently of seven-day jobs and denies runtime content deletion", async () => {
    const scope = owner(), job = await running(scope, "retained", [agentType]);
    const root = await collect(scope, job, provider([resource(scope, "retained-source")]));
    const before = await jobs.listJobs(scope);
    await fixture.operator.query("UPDATE power_platform_refresh_jobs SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id]);
    await retain(fixture.operator);
    expect(await jobs.listJobs(scope)).toMatchObject({ value: [], lastAttemptAt: null, lastSuccessAt: before.lastSuccessAt });
    expect(before.lastSuccessAt).not.toBeNull();
    expect((await selected(scope, root)).raw.value[0].nativeId).toBe("retained-source");
    expect((await jobs.listJobs({ ...scope, principalId: "not-owner" })).lastSuccessAt).toBeNull();
    await expect(fixture.runtime.query("DELETE FROM power_platform_record_rows WHERE generation_id=$1", [root.baselineId])).rejects.toThrow();
  });

  it("retains published source reads and success past freshness but rejects an expired read lease", async () => {
    const scope = owner(), job = await running(scope, "expiry", [agentType]);
    const root = await collect(scope, job, provider([resource(scope, "expiring")]), { expiresAt: new Date(Date.now() + 2_000) });
    const pin = await selected(scope, root);
    expect(pin.raw.counts.total).toBe(1);
    const success = (await jobs.listJobs(scope)).lastSuccessAt;
    expect(success).not.toBeNull();
    await new Promise(resolve => setTimeout(resolve, 2_050));
    expect((await pin.queries.page(pin.selection.id, pin.identity)).value).toEqual(pin.raw.value);
    expect((await selected(scope, root)).raw.value).toEqual(pin.raw.value);
    expect((await jobs.listJobs(scope)).lastSuccessAt).toBe(success);
    await fixture.operator.query("UPDATE data_read_selections SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [pin.selection.id]);
    await expect(pin.queries.page(pin.selection.id, pin.identity)).rejects.toMatchObject({ code: "selection_invalidated", details: { reason: "expired" } });
  });

  it.each([
    "microsoft.powerapps/canvasapps", "microsoft.powerapps/modeldrivenapps", "microsoft.powerapps/codeapps", "microsoft.powerapps/apps",
    "microsoft.powerautomate/cloudflows", "microsoft.powerautomate/agentflows", "microsoft.powerautomate/m365agentflows",
    "microsoft.powerplatformconnector/connectors", "microsoft.powerplatform/environmentgroups",
  ])("rejects retired type %s at job admission, the immutable attempt scope and streamed row boundary", async retired => {
    const scope = owner(), type = retired as PowerPlatformResourceType;
    await expect(jobs.submit(scope, { idempotencyKey: "retired", requestedTypes: [type], roleScope: "full" }))
      .rejects.toMatchObject({ code: "invalid_inventory_scope" });
    await expect(fixture.runtime.query(`INSERT INTO power_platform_refresh_jobs
      (id,tenant_id,principal_id,idempotency_key,request_hash,role_scope,requested_types)
      VALUES(gen_random_uuid(),$1,$2,'retired',$3,'full',$4)`, [scope.tenantId, scope.principalId, "a".repeat(64), JSON.stringify([type])]))
      .rejects.toMatchObject({ code: "23514" });
    const store = new InventoryGenerations(fixture.runtime), input = inventoryInput(scope.principalId, "power_platform");
    input.scope.tenantId = scope.tenantId;
    const intent = { domain: "power_platform" as const, mode: "baseline" as const, channel: "catalog" as const, resourceTypes: [type] };
    input.scope.selector = inventorySelector(intent);
    await expect(store.execute(input, intent, async () => {}, { authorize: async () => {} })).rejects.toMatchObject({ code: "23514" });
    const valid = { ...intent, resourceTypes: [agentType] as PowerPlatformResourceType[] };
    input.scope.selector = inventorySelector(valid);
    await expect(store.execute({ ...input, jobId: randomUUID() }, valid, async lease => {
      await store.appendBounded(lease, [powerPlatformInventoryRecord({
        tenantId: scope.tenantId, nativeId: "retired", type, environmentId, displayName: "Retired", location: null,
        createdAt: null, createdBy: null, lastPublishedAt: null, sourceSystem: "power_platform", authoringTool: null,
        creatorType: "unknown", agentKind: "not_agent", lifecycle: "unknown", identityConfidence: "exact_native",
        identifiers: [], provenance: {}, details: {}, unknownFieldCount: 0,
      })]);
    }, { authorize: async () => {} })).rejects.toThrow("inventory_resource_scope");
  });
});

describe.each(["full", "unknown"] as const)("42-page streamed native provider with %s role hint", roleScope => {
  const scope = owner();
  let prior: Root, changed: Root;
  describe.each([{ total: 4_140, start: 0, key: "first" }, { total: 4_173, start: 1, key: "changed" }])(
    "$total provider records through one backpressured generation", ({ total, start, key }) => {
      const controller = new AbortController();
      const gates = Array.from({ length: 42 }, () => {
        let release!: () => void;
        const promise = new Promise<void>(resolve => { release = resolve; });
        return { promise, release };
      });
      let completedPages = 0, failure: unknown, pending: Promise<Root | null>;
      let job: Awaited<ReturnType<typeof running>>;
      const fetcher: Fetcher = vi.fn(async (_url, init) => {
        const { Options: options } = JSON.parse(String(init?.body));
        const offset = Number(options.SkipToken ?? 0), count = Math.min(100, total - offset), signal = init!.signal!;
        signal.throwIfAborted();
        let abort!: () => void;
        try {
          await Promise.race([gates[offset / 100].promise, new Promise<never>((_resolve, reject) => {
            abort = () => reject(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
          })]);
        } finally { signal.removeEventListener("abort", abort); }
        return Response.json({ totalRecords: total, count, resultTruncated: 1,
          ...offset + count < total ? { skipToken: String(offset + count) } : {},
          data: Array.from({ length: count }, (_, index) => resource(scope, `agent-${String(start + offset + index).padStart(4, "0")}`)),
        });
      });
      beforeAll(async () => {
        job = await running(scope, key, powerPlatformResourceTypes, roleScope);
        pending = collect(scope, job, fetcher, { signal: controller.signal, onProgress: pages => { completedPages = pages; } })
          .catch(error => { failure = error; return null; });
      });
      afterAll(async () => {
        controller.abort(new Error("synthetic streamed-stage cleanup"));
        gates.forEach(gate => gate.release());
        await pending;
      });
      it.each(Array.from({ length: 14 }, (_, index) => index * 3))("persists three bounded pages starting at %i without publishing a partial head", async firstPage => {
        for (const gate of gates.slice(firstPage, firstPage + 3)) gate.release();
        await expect.poll(() => {
          if (failure) throw failure;
          return completedPages;
        }, { interval: 10, timeout: 4_500 }).toBe(firstPage + 3);
        expect(await jobs.getJob(scope, job.id)).toMatchObject({
          observedCount: Math.min(total, (firstPage + 3) * 100), totalRecords: total, pageCount: firstPage + 3,
        });
        if (firstPage + 3 < 42) {
          expect((await fixture.runtime.query(`SELECT root.baseline_id FROM inventory_roots root
            JOIN data_scope_epochs epoch ON epoch.id=root.scope_id WHERE root.current
              AND epoch.tenant_id=$1 AND epoch.principal_id=$2 AND root.domain='power_platform'`,
          [scope.tenantId, scope.principalId])).rows).toEqual(prior ? [{ baseline_id: prior.baselineId }] : []);
        }
      });
      it("publishes the terminal truncated-flag page atomically with scalar job counts", async () => {
        const started = performance.now();
        const root = await pending;
        if (failure) throw failure;
        expect(root).not.toBeNull();
        expect(fetcher).toHaveBeenCalledTimes(42);
        expect(await jobs.getJob(scope, job.id)).toMatchObject({
          status: "succeeded", observedCount: total, totalRecords: total, pageCount: 42,
        });
        if (start) changed = root!; else prior = root!;
        process.stdout.write(`NATIVE_SOURCE_COMMIT ${JSON.stringify({ roleScope, total, elapsedMs: performance.now() - started })}\n`);
      });
      it("returns an exact bounded last page", async () => {
        const started = performance.now(), root = start ? changed : prior;
        const costs = new Map<string,{ calls: number;milliseconds: number;maximumMs: number }>();
        observePeakMemory(() => {});
        observeQueryWork(value => {
          const key = value.sql.slice(0,512);
          if (!costs.has(key) && costs.size<128) costs.set(key,{ calls: 0,milliseconds: 0,maximumMs: 0 });
          const cost = costs.get(key);
          if (cost) { cost.calls++;cost.milliseconds+=value.milliseconds;cost.maximumMs=Math.max(cost.maximumMs,value.milliseconds); }
        });
        fixture.runtime.on("acquire",checkpointQueries);
        let last: Awaited<ReturnType<typeof selected>>;
        try { last = await selected(scope, root, { sortBy: "displayName", sortDirection: "desc" }); }
        finally {
          fixture.runtime.removeListener("acquire",checkpointQueries);
          observeQueryWork();observePeakMemory();
          process.stdout.write(JSON.stringify({ contract: "native-last-page-query-work",roleScope,total,
            queries: [...costs].sort((a,b) => b[1].milliseconds-a[1].milliseconds).slice(0,5) })+"\n");
        }
        process.stdout.write(`NATIVE_SOURCE_SELECTED ${JSON.stringify({ roleScope, total, elapsedMs: performance.now() - started })}\n`);
        expect(last.raw.counts.total).toBe(total);
        expect(last.raw.value).toHaveLength(100);
        expect(last.raw.value[0].nativeId).toBe(`agent-${total + start - 1}`);
        expect(last.raw.value.at(-1)?.nativeId).toBe(`agent-${total + start - 100}`);
        expect(last.raw.page.nextCursor).toEqual(expect.any(String));
      });
      if (start) it("does not resurrect removed membership or overwrite the earlier baseline", async () => {
          expect((await selected(scope, changed, { search: "agent-0000" })).raw.counts.filtered).toBe(0);
          expect((await fixture.runtime.query(`SELECT count(*)::int AS count FROM inventory_memberships
            WHERE baseline_id=$1 AND valid_from_revision<=$2 AND (valid_to_revision IS NULL OR valid_to_revision>$2)`,
          [prior.baselineId, prior.revision])).rows[0].count).toBe(4_140);
      });
  });
  it("preserves the complete 4173-row source after a later incomplete authorized provider page", async () => {
    const job = await running(scope, "incomplete", powerPlatformResourceTypes, roleScope);
    await expect(collect(scope, job, provider([resource(scope, "partial")], 4_173))).rejects.toMatchObject({ code: "provider_schema" });
    expect((await selected(scope, changed)).raw.counts.total).toBe(4_173);
    expect((await fixture.runtime.query("SELECT baseline_id FROM inventory_roots WHERE scope_id=$1 AND current", [changed.scopeId])).rows)
      .toEqual([{ baseline_id: changed.baselineId }]);
    expect((await jobs.listJobs({ ...scope, principalId: "other-reader" })).value).toEqual([]);
  });
});
