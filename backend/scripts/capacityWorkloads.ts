import assert from "node:assert/strict";
import { capacityReportIdentity } from "./capacityHttpLoad.js";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { assertCapacityPublicationProgress,capacityBackgroundLoop,capacityWithCleanup,capacitySelectionExpired } from "./capacityBackground.js";
import { statSync } from "node:fs";
import { capacityInput, fixtureFetch } from "./capacityRuntime.js";
import { fixtureTenant, otherTenant, packageValue, userId, officialLine, key, expectedCanonical, type CapacityIdentityProfile } from "./capacityProvider.js";
import { CapacityTelemetry, MiB } from "./capacityTelemetry.js";
import { selectionIdentity, generationInput, directoryRecord } from "./largeTenantFixtures.js";
import { UserSourceProvider } from "../src/services/userSourceProvider.js";
import { UserSourceStages } from "../src/db/userSourceStages.js";
import { StreamedInventory } from "../src/services/streamedInventory.js";
import { GraphPackagesClient, packageInventoryReadPolicy } from "../src/services/graphPackages.js";
import { PowerPlatformResourceQueryClient } from "../src/services/powerPlatformResourceQuery.js";
import { InventoryGenerations, inventorySelector } from "../src/db/inventoryGenerations.js";
import { InventoryReconciliation } from "../src/services/inventoryReconciliation.js";
import { InventoryRuntime } from "../src/services/inventoryRuntime.js";
import { InventoryQueries } from "../src/db/inventoryQueries.js";
import { DataGenerations, prepareGenerationBatch, type GenerationLease } from "../src/db/dataGenerations.js";
import { BoundedPool } from "../src/db/boundedPool.js";
import { OfficialReportImports } from "../src/db/officialReportImports.js";
import { LargeTenantUsersReports } from "../src/services/largeTenantUsersReports.js";
import { OfficialReportExports } from "../src/services/officialReportExports.js";
import { packageInventoryRecord } from "../src/services/inventoryRecordProjection.js";
import { allowlistedPackage } from "../src/services/packageObservation.js";
import { peakCheckpoint } from "../src/services/peakMemory.js";
import type { InventoryRoot } from "../src/types/inventoryRecords.js";
import { dataConnections } from "../src/db/dataConnections.js";
import { retainRecordData } from "../src/db/dataRetention.js";
import { schemaRegistry } from "../src/services/officialReportFields.js";
import { type PlanRecord } from "../src/db/dataGenerations.js";
import { backup, restore } from "./backup.js";
import { databaseSettings } from "../src/db/pool.js";
import { capacityOperation, physicalWork } from "./capacityPhysicalWork.js";

type Receipt = { name: string; status: "passed" | "failed" | "inconclusive"; elapsedMs: number; result?: unknown; error?: unknown };
function failure(error: unknown, depth = 0): unknown {
  if (!(error instanceof Error)) return String(error).slice(0, 4096);
  return { name: error.name, message: error.message.slice(0, 4096), stack: error.stack?.slice(0, 8192),
    ...("code" in error ? { code: error.code } : {}), ...("details" in error ? { details: error.details } : {}),
    ...(error.cause !== undefined && depth < 3 ? { cause: failure(error.cause, depth+1) } : {}),
    ...(error instanceof AggregateError && depth < 3 ? { errors: error.errors.slice(0, 8).map(value => failure(value, depth+1)) } : {}) };
}
async function together<T>(jobs: Promise<T>[]) {
  const outcomes = await Promise.allSettled(jobs);
  const failures = outcomes.filter(result => result.status === "rejected").map(result => result.reason);
  if (failures.length) throw new AggregateError(failures, "capacity_producers_failed");
  return outcomes.map(result => (result as PromiseFulfilledResult<T>).value);
}
export async function capacityIdentityProbe(database: pg.Pool, telemetry: CapacityTelemetry) {
  const owner = "capacity-physical-10k";
  const stream = new StreamedInventory(database,new GraphPackagesClient(fixtureFetch(10_000),packageInventoryReadPolicy),
    new PowerPlatformResourceQueryClient(fixtureFetch(10_000)));
  const nativeInput = capacityInput(owner,"inventory_power_platform");
  const types = ["microsoft.copilotstudio/agents"] as const;
  nativeInput.scope.selector = inventorySelector({ domain: "power_platform",resourceTypes: types });
  await stream.graphCatalog(capacityInput(owner),"synthetic",{ authorize: async () => {} });
  const graph = await stream.details(capacityInput(owner),"synthetic",
    ["package-000000","package-000001","package-000002","package-000003"],{ authorize: async () => {} });
  const native = await stream.powerPlatformCatalog(nativeInput,"synthetic",types,{ authorize: async () => {},roleScope: "full" });
  return fixedMutationProbe(database,telemetry,graph,native,owner,10_000);
}
async function isolatedInventoryBaseline(database: pg.Pool, principal: string, count: number, profile: CapacityIdentityProfile) {
  const stream = new StreamedInventory(database,new GraphPackagesClient(fixtureFetch(count,0,false,profile),packageInventoryReadPolicy),
    new PowerPlatformResourceQueryClient(fixtureFetch(count,0,false,profile)));
  const types = ["microsoft.copilotstudio/agents"] as const,nativeInput = capacityInput(principal,"inventory_power_platform");
  nativeInput.scope.selector = inventorySelector({ domain: "power_platform",resourceTypes: types });
  const [catalog,native] = await together([
    stream.graphCatalog(capacityInput(principal),"synthetic",{ authorize: async () => {} }),
    stream.powerPlatformCatalog(nativeInput,"synthetic",types,{ authorize: async () => {},expectedTenantId: fixtureTenant,roleScope: "full" }),
  ]);
  const graph = profile==="mixed" ? await stream.exact(capacityInput(principal),"synthetic",
    ["package-000000","package-000001","package-000002","package-000003"],{ authorize: async () => {} }) : catalog;
  const reconciliation = new InventoryReconciliation(database),input = capacityInput(principal,"inventory_canonical");
  await reconciliation.request(input,[graph,native]);
  const canonical = await reconciliation.runNext(input,async () => {});
  assert.ok(canonical);
  const expected = profile==="sparse" ? count*2 : expectedCanonical(count);
  const rows = (await database.query("SELECT row_count FROM inventory_revisions WHERE scope_id=$1 AND revision=$2",
    [canonical.scopeId,canonical.revision])).rows[0].row_count;
  assert.equal(Number(rows),expected);
  return { graph,native,canonical,profile,sourceRecords: count,expectedCanonical: expected };
}
export async function fullCapacity(database: pg.Pool, telemetry: CapacityTelemetry) {
  const receipts: Receipt[] = [];
  const attempt = async <T>(name: string, work: () => Promise<T>): Promise<T | undefined> => {
    const started = performance.now();
    telemetry.write({ event: "stage-start", name, at: started });
    try {
      const result = await work();
      const receipt: Receipt = { name, status: "passed", elapsedMs: performance.now() - started, result };
      receipts.push(receipt); telemetry.write({ event: "stage-result", ...receipt }); return result;
    } catch (error) {
      const receipt: Receipt = { name, status: "failed", elapsedMs: performance.now() - started,
        error: failure(error) };
      receipts.push(receipt); telemetry.write({ event: "stage-result", ...receipt }); return undefined;
    } finally { await telemetry.capturePlans(database,{ profile: name }); }
  };
  const principal = "capacity-main", identity = { ...selectionIdentity, tenantId: fixtureTenant, principalId: principal };
  const stages = new InventoryGenerations(database), reconciliation = new InventoryReconciliation(database);
  const lifecycle = new InventoryRuntime(database,async () => {});
  const queries = new InventoryQueries(database, "synthetic-capacity-query-cursor-key-32");
  const reports = new LargeTenantUsersReports(database, "synthetic-capacity-query-cursor-key-32", 35);
  const exports = new OfficialReportExports(reports, { tenantId: fixtureTenant, homeAccountId: principal,
    username: "capacity@example.invalid", displayName: "Synthetic capacity" }, "synthetic-capacity-query-cursor-key-32");
  let graph: InventoryRoot | undefined, native: InventoryRoot | undefined, canonical: InventoryRoot | undefined;
  const source = async (domain: "packages" | "power_platform", count = 100_000, version = 0, opposing = false,
    onFirstRequest?: () => Promise<void>) => {
    const owner = opposing ? "capacity-opposing" : principal, tenant = opposing ? otherTenant : fixtureTenant;
    const request = fixtureFetch(count,version,opposing);
    let first = true;
    const provider = async (input: string | URL, init?: RequestInit) => {
      if (first) { first = false; await onFirstRequest?.(); }
      return request(input,init);
    };
    const stream = new StreamedInventory(database, new GraphPackagesClient(provider, packageInventoryReadPolicy),
      new PowerPlatformResourceQueryClient(provider));
    const input = capacityInput(owner, `inventory_${domain}`, tenant);
    if (domain === "packages") {
      const root = await stream.graphCatalog(input, "synthetic", { authorize: async () => {} });
      if (count < 4) return root;
      return stream.details(capacityInput(owner, "inventory_packages", tenant), "synthetic",
        ["package-000000", "package-000001", "package-000002", "package-000003"], { authorize: async () => {} });
    }
    const types = ["microsoft.copilotstudio/agents"] as const;
    input.scope.selector = inventorySelector({ domain, resourceTypes: types });
    return stream.powerPlatformCatalog(input, "synthetic", types, { authorize: async () => {}, expectedTenantId: tenant, roleScope: "full" });
  };
  const userSource = async (kind: "directory" | "app_activity", count = 100_000, opposing = false) => {
    const input = capacityInput(opposing ? "capacity-opposing" : principal, kind, opposing ? otherTenant : fixtureTenant);
    return new UserSourceProvider(fixtureFetch(count, 0, opposing)).refresh(new UserSourceStages(database), input,
      { authorize: async () => "synthetic" });
  };
  await attempt("10k-fixed-twenty-key-physical-probe",() => capacityIdentityProbe(database,telemetry));
  await attempt("100k-directory-and-activity", () => together([userSource("directory"), userSource("app_activity")]));
  await attempt("100k-graph-and-power-platform", async () => {
    await together([source("packages").then(root => graph = root), source("power_platform").then(root => native = root)]);
    return { graph, native };
  });
  await attempt("10k-opposing-scope", async () => {
    const roots = await together<unknown>([source("packages", 10_000, 0, true), userSource("directory", 10_000, true)]);
    if (!graph) throw new Error("primary_source_unavailable");
    const pin = await queries.capture(identity, graph.scopeId);
    const opposingIdentity = { ...identity, tenantId: otherTenant, principalId: "capacity-opposing" };
    await assert.rejects(() => queries.page(pin.id, opposingIdentity));
    const opposing = await queries.capture(opposingIdentity,(roots[0] as InventoryRoot).scopeId);
    const ids = ["package-000000","package-000001"];
    assert.ok((await queries.exact(pin.id,identity,ids)).every(row => row.residual.isBlocked===false));
    assert.ok((await queries.exact(opposing.id,opposingIdentity,ids)).every(row => row.residual.isBlocked===true));
    const users = await reports.capture(opposingIdentity,"delegated","copilot_users",{ cohort: "licensed" });
    const page = await reports.page(users.id,opposingIdentity,{ limit: 100 });
    assert.equal(page.counts.total,10_000);
    assert.equal(page.counts.filtered,0);
    assert.equal(page.summary.licensedUsers,0);
    await queries.selections.invalidate(pin.id,identity); await queries.selections.invalidate(opposing.id,opposingIdentity);
    await reports.selections.invalidate(users.id,opposingIdentity);
    return { roots, overlappingIds: ids,opposingLicensedUsers: 0,crossScopeRejected: true };
  });
  await attempt("100k-users-200k-agents-1m-sparse-relationships", async () => {
    const imports = new OfficialReportImports(database), bundleId = randomUUID();
    const metadata = { reportingPeriod: { startDate: "2026-09-01", endDate: "2026-09-30", provenance: "operator_asserted" as const },
      sourceAsOf: { value: "2026-10-01T00:00:00Z", provenance: "operator_asserted" as const } };
    const parts = [];
    for (const [kind, count] of [["users", 100_000], ["agents", 200_000], ["userAgents", 1_000_000]] as const) {
      const response = await fetch(`http://controller:8080/official?kind=${kind}&count=${count}`);
      assert.equal(response.status, 200);
      const checksum = createHash("sha256"); let bytes = 0;
      async function* body() {
        for await (const value of response.body!) { checksum.update(value); bytes += value.byteLength; yield Buffer.from(value); }
      }
      await imports.stage(identity, { bundleId }, body(), metadata);
      parts.push({ kind, count, bytes, checksum: checksum.digest("hex") });
    }
    const accepted = await imports.acceptBundle(identity, bundleId, await imports.bundle(identity, bundleId));
    return { parts, accepted };
  });
  await attempt("canonical-linked-unlinked-ambiguous-conflicting", async () => {
    if (!graph || !native) throw new Error("native_baseline_unavailable");
    const input = capacityInput(principal, "inventory_canonical");
    await reconciliation.request(input, [graph, native]);
    canonical = (await reconciliation.runNext(input, async () => {})) ?? undefined;
    assert.ok(canonical);
    const count = (await database.query("SELECT row_count FROM inventory_roots WHERE baseline_id=$1", [canonical.baselineId])).rows[0].row_count;
    assert.equal(Number(count), expectedCanonical(100_000));
    const selection = await queries.capture(identity, canonical.scopeId);
    const summary = await queries.summary(selection.id, identity);
    assert.equal(summary.summary.linked, 2);
    assert.equal(summary.summary.ambiguous, 1);
    assert.equal(summary.summary.conflicting, 1);
    return { root: canonical, independentExpected: expectedCanonical(100_000), summary,
      oracle: "Two unique graph/native pairs merge; a graph matching two native resources and a contradictory graph remain separate." };
  });
  await attempt("source-100001-rejected-with-old-head-preserved", async () => {
    if (!graph) throw new Error("100k_source_baseline_unavailable");
    const old = graph;
    await assert.rejects(() => source("packages", 100_001), (error: unknown) => {
      telemetry.write({ event: "source-boundary-error", limit: 100_000, observed: 100_001, error: String(error) });
      return error instanceof Error && /limit|rows|count|quota/i.test(error.message);
    });
    const head = (await database.query("SELECT baseline_id,revision FROM inventory_roots WHERE scope_id=$1 AND current", [old.scopeId])).rows[0];
    assert.equal(head.baseline_id, old.baselineId); assert.equal(String(head.revision), old.revision);
    return { limit: 100_000, rejected: 100_001, preserved: head };
  });
  await attempt("100k-fixed-twenty-key-physical-probe",async () => {
    if (!graph || !native) throw new Error("native_baseline_unavailable");
    const probe = await fixedMutationProbe(database,telemetry,graph,native,principal,100_000);
    graph = probe.root;
    return probe;
  });
  await attempt("100k-distinct-publisher-facets", async () => {
    if (!graph) throw new Error("100k_source_baseline_unavailable");
    const pin = await queries.capture(identity, graph.scopeId);
    try {
      const pages = [];
      let cursor: string | undefined;
      for (let page = 0; page < 2; page++) {
        const value = await queries.facets(pin.id, identity, "publisher", { limit: 100, cursor });
        assert.equal(value.total, 100_000);
        assert.deepEqual(value.value.map(row => row.value), Array.from({ length: 100 }, (_, index) => `Publisher ${key(page*100+index)}`));
        cursor = value.nextCursor ?? undefined; assert.ok(cursor); pages.push({ rows: value.value.length, total: value.total });
      }
      const last = await queries.facets(pin.id, identity, "publisher", { limit: 100, search: "099999" });
      assert.equal(last.total, 1); assert.equal(last.value[0].value, "Publisher 099999");
      return { pages, searchedLast: last, independentExpected: 100_000 };
    } finally { await queries.selections.invalidate(pin.id, identity); }
  });
  await attempt("100k-authenticated-http-controller-slow-reader-disconnect", async () => {
    if (!graph) throw new Error("100k_source_baseline_unavailable");
    return (await import("./capacityHttp.js")).capacityHttp(database,telemetry,graph,principal);
  });
  await attempt("100k-real-browser-bounded-navigation",async () => {
    if (!graph) throw new Error("100k_source_baseline_unavailable");
    return (await import("./capacityHttp.js")).capacityHttp(database,telemetry,graph,principal,true);
  });
  await attempt("100k-first-middle-last-reverse-filter-page-oracle",async () => {
    if (!graph) throw new Error("100k_source_baseline_unavailable");
    const pin = await queries.capture(identity,graph.scopeId,{ sortBy: "displayName" });
    const observed = createHash("sha256"), expected = createHash("sha256");
    for (let i=0;i<100_000;i++) expected.update(`package-${key(i)}\n`);
    let cursor: string | undefined, rows = 0, requests = 0;
    const read = async (selection: string, pageCursor?: string) => {
      const started = performance.now();
      let succeeded = false;
      try {
        const page = await queries.page(selection,identity,{ limit: 100,cursor: pageCursor });
        const bytes = Buffer.byteLength(JSON.stringify(page)); peakCheckpoint("response.serialize");
        assert.ok(bytes<=MiB);
        succeeded = true;
        return page;
      } finally {
        telemetry.write({ event: "reader",cycle: 0,reader: 0,kind: "inventory-page",
          request: ++requests,succeeded,milliseconds: performance.now()-started });
      }
    };
    try {
      do {
        const page = await read(pin.id,cursor);
        assert.equal(page.counts.total,100_000); assert.equal(page.counts.filtered,100_000);
        assert.equal(page.value.length,100);
        for (const row of page.value) {
          assert.equal(row.nativeId,`package-${key(rows++)}`);
          observed.update(row.nativeId+"\n");
        }
        if (rows===50_000 || rows===100_000) {
          assert.ok(page.page.previousCursor);
          const reverse = await read(pin.id,page.page.previousCursor);
          assert.equal(reverse.value[0].nativeId,`package-${key(rows-200)}`);
          const forward = await read(pin.id,reverse.page.nextCursor!);
          assert.deepEqual(forward.value.map(value => value.nativeId),page.value.map(value => value.nativeId));
          telemetry.write({ event: "page-position-oracle",position: rows,reverse: true,returned: page.value.length });
        }
        cursor = page.page.nextCursor ?? undefined;
      } while (cursor);
      assert.equal(rows,100_000);
      const checksum = observed.digest("hex");
      assert.equal(checksum,expected.digest("hex"));
      for (const [query,expectedId,filtered] of [
        [{ search: "Agent 050000" },"package-050000",1],
        [{ publisher: "Publisher 099999" },"package-099999",1],
        [{ blocked: true },null,0],
      ] as const) {
        const selected = await queries.capture(identity,graph.scopeId,query);
        try {
          const page = await read(selected.id);
          assert.equal(page.counts.total,100_000); assert.equal(page.counts.filtered,filtered);
          assert.equal(page.value[0]?.nativeId ?? null,expectedId);
        } finally { await queries.selections.invalidate(selected.id,identity); }
      }
      return { rows,requests,checksum,firstMiddleLastReverse: true,filters: 3,selectionLeaseUnchanged: true };
    } finally { await queries.selections.invalidate(pin.id,identity); }
  });
  await attempt("five-replacements-concurrent-readers-exports-gc", async () => {
    if (!graph || !native) throw new Error("native_baseline_unavailable");
    const cycles = [];
    let totalRequests = 0;
    for (let cycle = 1; cycle <= 5; cycle++) {
      const pin = await queries.capture(identity, graph.scopeId, { sortBy: "displayName" });
      const reportPins = [];
      for (const endpoint of ["copilot_users", "official_users", "official_agents", "relationships"] as const) {
        reportPins.push(await reports.capture(identity, "delegated", endpoint, { sort: "name", order: cycle % 2 ? "asc" : "desc" }));
      }
      const warmups = [];
      for (let reader = -1; reader < reportPins.length; reader++) {
        const started = performance.now();
        try {
          if (reader < 0) await queries.page(pin.id, identity, { limit: 100 });
          else await reports.page(reportPins[reader].id, identity, { limit: 100 });
          warmups.push({ reader, succeeded: true, milliseconds: performance.now() - started });
        } catch (error) {
          warmups.push({ reader, succeeded: false, milliseconds: performance.now() - started, error: failure(error) });
        }
      }
      telemetry.write({ event: "cycle-cold-warmup", cycle, warmups,
        scope: "One cold page per immutable selection before concurrent warm reads; failures are retained and fail the cycle, without omitting its full concurrent attempt." });
      await telemetry.capturePlans(database,{ profile: `replacement-${cycle}-cold-selected-pages` });
      const stopped = new AbortController();
      let release!: () => void;
      const contentionsReady = new Promise<void>(resolve => { release = resolve; });
      const arrivals = [0,1].map(() => {
        let settle!: () => void;
        const reached = new Promise<void>(resolve => { settle = resolve; });
        return { reached,settle,admitted: false };
      });
      const replacementPending = together((["packages","power_platform"] as const).map((domain,index) => {
        const job = source(domain,100_000,cycle,false,async () => {
          arrivals[index].admitted = true; arrivals[index].settle(); await contentionsReady;
        });
        void job.then(arrivals[index].settle,arrivals[index].settle);
        return job;
      }));
      void replacementPending.catch(() => {});
      await Promise.all(arrivals.map(value => value.reached));
      const exportAdmissions = await Promise.allSettled([exports.create(identity,{ selectionId: pin.id,kind: "graph_packages" }),
        exports.create(identity,{ selectionId: pin.id,kind: "graph_packages" })]);
      const admission = { replacements: arrivals.filter(value => value.admitted).length,
        exports: exportAdmissions.filter(value => value.status==="fulfilled").length };
      telemetry.write({ event: "cycle-admission",cycle,...admission,
        scope: "Both real collector leases reach their first provider request before contention starts; original admission and acquisition bounds are unchanged." });
      const readers = Array.from({ length: 12 }, async (_, reader) => {
        let cursor: string | undefined, count = 0, failed = 0, expectedOffset = 0;
        let selected = reader>=4 && reader<8 ? reportPins[reader-4] : pin;
        let ownedSelection = false,rotations = 0;
        const releaseSelection = (id: string) => reader>=4 && reader<8
          ? reports.selections.invalidate(id,identity) : queries.selections.invalidate(id,identity);
        while (!stopped.signal.aborted || count < 20) {
          const started = performance.now();
          const kind = reader < 4 ? "inventory-page" : reader < 8 ? "report-page" : reader === 8 ? "summary"
            : reader === 9 ? "facet" : "detail";
          let succeeded = false;
          try {
            if (kind === "summary") await queries.summary(selected.id, identity);
            else if (kind === "facet") {
              const page = await queries.facets(selected.id, identity, "publisher", { limit: 100, cursor });
              assert.equal(page.total, 100_000);
              for (const [index, row] of page.value.entries()) assert.equal(row.value, `Publisher ${key(expectedOffset+index)}`);
              expectedOffset += page.value.length; cursor = page.nextCursor ?? undefined;
              if (!cursor) expectedOffset = 0;
            } else if (kind === "detail") {
              const detail = await queries.packageDetail(selected.id, identity, `package-${key((count*101+reader)%100_000)}`);
              const serialized = JSON.stringify(detail); peakCheckpoint("response.serialize");
              assert.ok(Buffer.byteLength(serialized) <= 512*1024);
            } else if (kind === "report-page") {
              const index = reader-4, expectedCount = [100_000, 100_000, 200_000, 1_000_000][index];
              const page = await reports.page(selected.id, identity, { limit: 100, cursor });
              assert.equal(page.counts.total, expectedCount); assert.ok(page.value.length <= 100);
              const serialized = JSON.stringify(page); peakCheckpoint("response.serialize"); assert.ok(Buffer.byteLength(serialized) <= MiB);
              if (index < 3) for (const [rowIndex, raw] of page.value.entries()) {
                const ordinal = cycle % 2 ? expectedOffset+rowIndex : expectedCount-expectedOffset-rowIndex-1;
                assert.equal(capacityReportIdentity(index, raw),
                  index < 2 ? `user-${key(ordinal)}@example.invalid` : `agent-${key(ordinal)}`);
              }
              expectedOffset += page.value.length; cursor = page.page.nextCursor ?? undefined;
              if (!cursor) expectedOffset = 0;
            } else {
              const page = await queries.page(selected.id, identity, { limit: 100, cursor });
              assert.equal(page.counts.total, 100_000);
              const serialized = JSON.stringify(page); peakCheckpoint("response.serialize");
              assert.ok(Buffer.byteLength(serialized) <= MiB);
              for (const [index, row] of page.value.entries()) assert.equal(row.nativeId, `package-${key(expectedOffset+index)}`);
              const backwards = count % 10 === 8 && Boolean(page.page.previousCursor);
              cursor = (backwards ? page.page.previousCursor : page.page.nextCursor) ?? undefined;
              expectedOffset += backwards ? -100 : page.value.length;
              if (!cursor) expectedOffset = 0;
            }
            succeeded = true;
          } catch (error) {
            failed++; telemetry.write({ event: "reader-rejection", cycle, reader, code: String(error) });
            if (capacitySelectionExpired(error,selected.expiresAt)) {
              try {
                const previous = selected;
                if (ownedSelection) await releaseSelection(previous.id);
                selected = reader>=4 && reader<8
                  ? await reports.capture(identity,"delegated",
                    (["copilot_users","official_users","official_agents","relationships"] as const)[reader-4],
                    { sort: "name",order: cycle%2 ? "asc" : "desc" })
                  : await queries.capture(identity,graph!.scopeId,{ sortBy: "displayName" });
                ownedSelection = true;rotations++;cursor = undefined;expectedOffset = 0;
                telemetry.write({ event: "cycle-reader-selection-rotation",cycle,reader,previous: previous.id,
                  previousExpiry: previous.expiresAt,next: selected.id,
                  scope: "The expired old-pin read remains a qualification failure. Fresh current selections preserve real sustained reader pressure; they do not count as old-pin proof." });
              } catch (rotationError) {
                telemetry.write({ event: "reader-rejection",cycle,reader,code: String(rotationError),operation: "selection-rotation" });
              }
            }
          }
          totalRequests++; count++;
          telemetry.write({ event: "reader", cycle, reader, kind,succeeded,milliseconds: performance.now() - started });
          await delay(20);
        }
        if (ownedSelection) {
          try { await releaseSelection(selected.id); }
          catch (error) { failed++;telemetry.write({ event: "reader-rejection",cycle,reader,code: String(error),operation: "selection-release" }); }
        }
        return { reader, count, failed,rotations };
      });
      const exportWork = async (index: number) => {
        const accepted = exportAdmissions[index];
        if (accepted.status==="rejected") throw accepted.reason;
        const id = accepted.value;
        await exports.build(id, identity, "graph_packages");
        const status = await exports.status(id, identity), hash = createHash("sha256"), ids = createHash("sha256"), expected = createHash("sha256");
        for (let i = 0; i < 100_000; i++) expected.update(`package-${key(i)}\n`);
        let bytes = 0, chunks = 0, rows = 0, pending = "", header = true;
        for await (const chunk of exports.engine.download(id, identity, new AbortController().signal)) {
          assert.ok(chunk.length <= 262144); bytes += chunk.length; hash.update(chunk); chunks++;
          pending += chunk.toString("utf8");
          let end;
          while ((end = pending.indexOf("\r\n")) !== -1) {
            const line = pending.slice(0, end); pending = pending.slice(end+2);
            if (header) { assert.ok(line.startsWith("\uFEFFid,")); header = false; continue; }
            const match = /^"(package-\d{6})",/.exec(line); assert.ok(match);
            ids.update(match[1]+"\n"); rows++;
          }
          assert.ok(Buffer.byteLength(pending) <= 262144);
          if (index === 1) await delay(25);
        }
        assert.equal(pending, ""); assert.equal(rows, 100_000); assert.equal(ids.digest("hex"), expected.digest("hex"));
        assert.equal(bytes, status.bytes);
        const stored = (await database.query("SELECT checksum FROM data_exports WHERE id=$1", [id])).rows[0].checksum;
        assert.equal(hash.digest("hex"), stored);
        return { id, bytes, rows: status.rows, independentRows: rows, chunks };
      };
      const gc = async () => {
        let slices = 0,inventoryCollections = 0;
        while (!stopped.signal.aborted) {
          await stages.gcSlice(graph!);
          inventoryCollections += Number(await lifecycle.collect());
          await dataConnections(database).run(client => retainRecordData(client));
          slices++; await delay(0);
        }
        assert.ok(inventoryCollections>0,"the real inventory lifecycle collector must run");
        return { slices,inventoryCollections };
      };
      const background = Promise.allSettled([exportWork(0), exportWork(1), gc()]);
      let replacement, replacementError: unknown;
      try { release(); replacement = await replacementPending; }
      catch (error) { replacementError = error; }
      finally { release(); stopped.abort(); }
      const readerResults = await Promise.all(readers), work = await background;
      if (replacementError) {
        telemetry.write({ event: "cycle-failed",cycle,readers: readerResults,work: work.map(result =>
          result.status==="fulfilled" ? result : { status: result.status,reason: failure(result.reason) }) });
      }
      if (replacement) [graph, native] = replacement;
      let canonicalReplacement: InventoryRoot | null = null;
      if (replacement) {
        try {
          const input = capacityInput(principal,"inventory_canonical");
          await reconciliation.request(input,replacement);
          canonicalReplacement = await reconciliation.runNext(input,async () => {});
          assert.ok(canonicalReplacement,"a completed replacement also needs its canonical publication");
        } catch (error) { replacementError = error; }
      }
      if (cycle === 2) {
        const old = graph!;
        await assert.rejects(() => stages.execute(capacityInput(principal),
          { domain: "packages", mode: "baseline", channel: "catalog" }, async lease => {
            await stages.appendBounded(lease, [packageInventoryRecord(allowlistedPackage(packageValue(0, 90)))]);
            throw new Error("capacity_middle_replacement_failure");
          }, { authorize: async () => {} }), /capacity_middle_replacement_failure/);
        const cancel = new AbortController();
        const aborted = stages.execute(capacityInput(principal), { domain: "packages", mode: "baseline", channel: "catalog" },
          async (_lease, signal) => { await delay(60_000, undefined, { signal }); }, { authorize: async () => {}, signal: cancel.signal });
        setTimeout(() => cancel.abort(new Error("capacity_middle_replacement_cancel")), 1000);
        await assert.rejects(aborted);
        const current = (await database.query("SELECT baseline_id FROM inventory_roots WHERE scope_id=$1 AND current", [old.scopeId])).rows[0];
        assert.equal(current.baseline_id, old.baselineId);
      }
      await telemetry.capturePlans(database,{ profile: `replacement-${cycle}-before-selection-release` });
      cycles.push({ cycle, admission,sourceReplacementComplete: Boolean(replacement),
        canonicalReplacementComplete: Boolean(canonicalReplacement),replacementComplete: !replacementError,
        complete: !replacementError && admission.replacements===2 && admission.exports===2 && warmups.every(warmup => warmup.succeeded)
          && readerResults.every(reader => !reader.failed) && work.every(result => result.status==="fulfilled"),
        error: replacementError ? failure(replacementError) : undefined,
        warmups, readers: readerResults, work: work.map(result => result.status==="fulfilled" ? result
          : { status: result.status,reason: failure(result.reason) }), settled: process.memoryUsage() });
      telemetry.write({ event: "cycle", ...cycles.at(-1) });
      for (const selected of reportPins) await reports.selections.invalidate(selected.id, identity);
      await queries.selections.invalidate(pin.id, identity);
    }
    assert.ok(totalRequests >= 1000);
    assert.equal(cycles.filter(cycle => cycle.complete).length,5,"five complete concurrent replacement cycles are required");
    assert.equal(cycles.flatMap(cycle => cycle.readers).reduce((sum, reader) => sum+reader.failed, 0), 0,
      "reader failures are measured qualification failures, not successful requests");
    assert.equal(cycles.flatMap(cycle => cycle.work).filter(result => result.status === "rejected").length, 0);
    return { cycles, totalRequests };
  });
  await attempt("separate-small-component-merge-and-split",() => mergeSplit(database,telemetry));
  const detailPrincipal = "capacity-detail";
  const detailBaseline = await attempt("100k-uniform-sparse-detail-baseline",
    () => isolatedInventoryBaseline(database,detailPrincipal,100_000,"sparse"));
  await attempt("two-100k-detail-sweeps", async () => {
    if (!detailBaseline) throw new Error("100k_sparse_baseline_unavailable");
    return detailSweeps(database,telemetry,detailBaseline.graph,detailPrincipal,detailBaseline.native);
  });
  await attempt("post-detail-pin-release-and-ten-minute-retention", () => {
    if (!detailBaseline) throw new Error("100k_sparse_baseline_unavailable");
    const actor = { ...identity,principalId: detailPrincipal };
    const engine = new OfficialReportExports(reports,{ tenantId: fixtureTenant,homeAccountId: detailPrincipal,
      username: "capacity@example.invalid",displayName: "Synthetic detail capacity" },"synthetic-capacity-query-cursor-key-32");
    return detailRetention(database,telemetry,detailPrincipal,engine,actor);
  });
  await attempt("600-second-retry-heartbeat-cancellation", () => heartbeatWorkload(database, telemetry, graph));
  await attempt("actual-worker-death-expiry-takeover", () => workerTakeover(database, telemetry));
  await attempt("exact-batch-and-queue-boundaries", () => batchAndQueueBoundaries(database));
  await attempt("normalized-plan-fact-and-page-boundaries", () => normalizedQuotaBoundaries(database));
  await attempt("256MiB-file-and-one-byte-over", () => reportFileBoundary(database,telemetry));
  await attempt("official-row-limits-plus-one-preserve-publication",async () => {
    const actor = { ...identity,tenantId: otherTenant,principalId: "capacity-report-boundaries" };
    const imports = new OfficialReportImports(database), bundleId = randomUUID();
    const stage = async (kind: "users"|"agents"|"userAgents",count: number,bundleId: string) => {
      const response = await fetch(`http://controller:8080/official?kind=${kind}&count=${count}`);
      assert.equal(response.status,200);
      async function* body() { for await (const chunk of response.body!) yield Buffer.from(chunk); }
      return imports.stage(actor,{ bundleId },body());
    };
    for (const kind of ["users","agents","userAgents"] as const) await stage(kind,1,bundleId);
    const published = await imports.acceptBundle(actor,bundleId,await imports.bundle(actor,bundleId));
    const results = [];
    for (const [kind,limit] of [["users",100_000],["agents",200_000],["userAgents",1_000_000]] as const) {
      const started = performance.now();
      await assert.rejects(() => stage(kind,limit+1,randomUUID()),{ status: 413,code: "row_limit_exceeded",
        message: `CSV ${kind} row limit exceeded.` });
      const current = (await database.query("SELECT active_set_id,revision::text FROM official_usage_state WHERE tenant_id=$1",[otherTenant])).rows[0];
      assert.equal(current.active_set_id,published.setId); assert.equal(current.revision,published.activeRevision);
      const result = { kind,limit,attempted: limit+1,diagnostic: "row_limit_exceeded",oldPublicationPreserved: true,
        milliseconds: performance.now()-started };
      results.push(result); telemetry.write({ event: "report-row-boundary",...result });
    }
    return results;
  });
  await attempt("residual-exact-and-over-limit", () => residualBoundary(database));
  await attempt("10k-users-500-plans", () => wideDirectory(database, telemetry));
  await attempt("100-agents-10k-child-facts", () => deepInventory(database, telemetry));
  await attempt("one-user-10k-observed-relationships", () => highDegreeReports(database, telemetry));
  await attempt("32-report-sets-history-pins", () => reportHistory(database, telemetry));
  await attempt("large-schema-backup-under-churn-and-isolated-restore", () => capacityBackup(database, telemetry));
  return receipts;
}

export async function normalizedQuotaBoundaries(database: pg.Pool) {
  const stages = new DataGenerations(database), input = capacityInput("capacity-plan-boundary","directory");
  const plans = (offset: number): PlanRecord[] => Array.from({ length: 250 },(_,i) => ({
    identity: `${userId(0)}:plan-${offset+i}`,user_id: userId(0),plan_id: `plan-${offset+i}`,
    service: "synthetic",display_name: `Plan ${offset+i}`,state: "unknown",capability_status: null,assigned_at: null,residual: {},
  }));
  const old = await stages.execute(input,async lease => {
    await stages.append(lease,"directory",0,[directoryRecord(userId(0),{ plan_count: 1000 })]);
    for (let batch=0;batch<4;batch++) await stages.append(lease,"plans",batch+1,plans(batch*250));
    await stages.validate(lease,{ rows: 1,children: 1000,batches: 5,pages: 0,wireRows: 0 });
    await stages.publish(lease); return lease;
  });
  await assert.rejects(() => stages.execute(input,lease =>
    stages.append(lease,"directory",0,[directoryRecord(userId(0),{ plan_count: 1001 })])),
  { status: 413,code: "data_directory_plan_count",details: { limit: 1000,observed: 1001 } });
  assert.equal((await database.query("SELECT generation_id FROM data_generation_heads WHERE scope_id=$1",[old.scopeId])).rows[0].generation_id,old.id);
  const inventory = new InventoryGenerations(database), owner = "capacity-normalized-fact-boundary";
  const record = packageInventoryRecord(packageValue(0));
  while (record.facts.length<10_000) record.facts.push({ kind: "capacity-child",value: String(record.facts.length),payload: {} });
  const publish = (over: boolean) => inventory.execute(capacityInput(owner),
    { domain: "packages",mode: "baseline",channel: "catalog" },async lease => {
      await inventory.visit(lease,"normalized-boundary");
      const first = over ? { ...record,facts: [...record.facts,{ kind: "capacity-child",value: "10000",payload: {} }] } : record;
      const records = [first,...Array.from({ length: 99 },(_,i) => packageInventoryRecord(packageValue(i+1)))];
      await inventory.appendBounded(lease,records);
      await inventory.acceptPage(lease,{ token: "normalized-boundary",nextToken: null,records,rawCount: 100,expectedCount: 100,page: 1 },100);
    },{ authorize: async () => {} });
  const root = await publish(false);
  assert.equal(Number((await database.query("SELECT count(*)::text AS n FROM inventory_facts WHERE generation_id=$1 AND identity=$2",
    [root.baselineId,record.identity])).rows[0].n),10_000);
  await assert.rejects(() => publish(true),{ status: 413,code: "inventory_facts",details: { limit: 10_000,observed: 10_001 } });
  assert.equal((await database.query("SELECT baseline_id FROM inventory_roots WHERE scope_id=$1 AND current",[root.scopeId])).rows[0].baseline_id,root.baselineId);
  const queries = new InventoryQueries(database,"synthetic-capacity-query-cursor-key-32");
  const identity = { ...selectionIdentity,tenantId: fixtureTenant,principalId: owner };
  const selected = await queries.capture(identity,root.scopeId);
  try {
    assert.equal((await queries.page(selected.id,identity,{ limit: 100 })).value.length,100);
    await assert.rejects(() => queries.page(selected.id,identity,{ limit: 101 }),{ status: 400,code: "invalid_cursor" });
  } finally { await queries.selections.invalidate(selected.id,identity); }
  return { planFacts: 1000,rejectedPlanFacts: 1001,normalizedFacts: 10_000,rejectedNormalizedFacts: 10_001,
    pageRows: 100,rejectedPageRows: 101,oldPublicationsPreserved: true,
    scope: "Normalized writer quota boundary with existing metadata retained; not a claim that 10000 observed provider children fit that quota." };
}

async function mergeSplit(database: pg.Pool,telemetry: CapacityTelemetry) {
  const principal = "capacity-merge-split";
  const { graph,native } = await isolatedInventoryBaseline(database,principal,100,"mixed");
  const reconciliation = new InventoryReconciliation(database), reader = new InventoryQueries(database,"synthetic-capacity-query-cursor-key-32");
  const identity = { ...selectionIdentity,tenantId: fixtureTenant,principalId: principal };
  const input = capacityInput(principal,"inventory_canonical"), scope = await reconciliation.request(input,[graph,native]);
  await reconciliation.runNext(input,async () => {});
  const members = async (root: InventoryRoot) => {
    const pin = await reader.capture(identity,root.scopeId);
    const ids = (await database.query(`SELECT m.identity FROM inventory_memberships m JOIN unified_agent_memberships s
      ON s.generation_id=m.generation_id AND s.identity=m.identity WHERE m.baseline_id=$1 AND m.valid_from_revision<=$2
      AND (m.valid_to_revision IS NULL OR m.valid_to_revision>$2) AND s.source_scope_id=$3 AND s.source_identity='package-000000'`,
    [root.baselineId,root.revision,graph.scopeId])).rows;
    assert.equal(ids.length,1);
    const page = await reader.members(pin.id,identity,ids[0].identity,{ limit: 100 });
    return { pin,id: ids[0].identity,page };
  };
  const prior = (await database.query("SELECT baseline_id,revision::text FROM inventory_roots WHERE scope_id=$1 AND current",[scope.scopeId])).rows[0];
  assert.ok(prior);
  const old = await members({ baselineId: prior.baseline_id,revision: prior.revision,scopeId: scope.scopeId } as InventoryRoot);
  assert.deepEqual(old.page.value.map(row => row.native_id).sort(),["native-000000","package-000000"]);
  const observer = await physicalWork(database,telemetry), results = [];
  try {
    for (const version of [30,31]) {
      const start = (await database.query("SELECT pg_current_wal_insert_lsn()::text AS lsn")).rows[0].lsn;
      const stream = new StreamedInventory(database,new GraphPackagesClient(fixtureFetch(100,version,false,"merge-split"),packageInventoryReadPolicy));
      const root = await capacityOperation(`merge-split:${version}:native`,() =>
        stream.exact(capacityInput(principal),"synthetic",["package-000000"],{ authorize: async () => {} }));
      const request = capacityInput(principal,"inventory_canonical");
      await capacityOperation(`merge-split:${version}:enqueue`,() => reconciliation.request(request,[root,native]));
      const canonical = await capacityOperation(`merge-split:${version}:canonical`,() => reconciliation.runNext(request,async () => {}));
      assert.ok(canonical); assert.equal(canonical.scopeId,scope.scopeId);
      const value = await members(canonical);
      const expected = version===30 ? ["native-000001","package-000000","package-000001"] : ["native-000000","package-000000"];
      assert.deepEqual(value.page.value.map(row => row.native_id).sort(),expected);
      const wal = (await database.query("SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(),$1)::text AS bytes",[start])).rows[0].bytes;
      results.push({ version,expected,wal,physical: await observer.flush() });
      assert.deepEqual((await reader.members(old.pin.id,identity,old.id,{ limit: 100 })).value.map(row => row.native_id).sort(),
        ["native-000000","package-000000"]);
      await reader.selections.invalidate(value.pin.id,identity);
    }
    return results;
  } finally {
    await reader.selections.invalidate(old.pin.id,identity);
    await observer.close();
  }
}

async function batchAndQueueBoundaries(database: pg.Pool) {
  assert.ok(database instanceof BoundedPool);
  const held = await Promise.all(Array.from({ length: 3 },() => database.connect()));
  const waiting = Array.from({ length: 32 },() => database.connect().then(client => { client.release(); }));
  try {
    assert.equal(database.admissionState.queue,32);
    await assert.rejects(() => database.connect(),{ code: "data_queue_full" });
    const renewal = await database.connectRenewal();
    try { await renewal.query("SELECT 1"); } finally { renewal.release(); }
  } finally { for (const client of held) client.release(); await Promise.all(waiting); }
  const stages = new DataGenerations(database), input = capacityInput("capacity-batch","directory");
  const exact = await stages.execute(input,async lease => {
    const rows = Array.from({ length: 4 },(_,i) => directoryRecord(userId(i),{ residual: { value: "x".repeat(240000) } }));
    const remaining = 1048576-prepareGenerationBatch(lease,rows).bytes;
    for (const [index,row] of rows.entries()) (row.residual as { value: string }).value += "x".repeat(Math.floor(remaining/4)+Number(index<remaining%4));
    assert.equal(prepareGenerationBatch(lease,rows).bytes,1048576);
    await stages.append(lease,"directory",0,rows);
    await stages.validate(lease,{ rows: 4,children: 0,batches: 1,pages: 0,wireRows: 0 });
    await stages.publish(lease);
    return { lease,rows };
  });
  await assert.rejects(() => stages.execute(input,async lease => {
    const over = exact.rows.map((row,index) => ({ ...row,residual: { value: (row.residual as { value: string }).value+(index===0 ? "x" : "") } }));
    await stages.append(lease,"directory",0,over);
  }),{ code: "data_batch_bytes" });
  assert.equal((await database.query("SELECT generation_id FROM data_generation_heads WHERE scope_id=$1",[exact.lease.scopeId])).rows[0].generation_id,exact.lease.id);
  const rowInput = capacityInput("capacity-batch-rows","directory");
  const published = await stages.execute(rowInput,async lease => {
    await stages.append(lease,"directory",0,Array.from({ length: 250 },(_,i) => directoryRecord(userId(i))));
    await stages.validate(lease,{ rows: 250,children: 0,batches: 1,pages: 0,wireRows: 0 });
    await stages.publish(lease); return lease;
  });
  await assert.rejects(() => stages.execute(rowInput,lease =>
    stages.append(lease,"directory",0,Array.from({ length: 251 },(_,i) => directoryRecord(userId(i))))),{ code: "data_batch_rows" });
  assert.equal((await database.query("SELECT generation_id FROM data_generation_heads WHERE scope_id=$1",[published.scopeId])).rows[0].generation_id,published.id);
  return { queue: 32,rejectedQueue: 33,independentRenewal: true,batchBytes: 1048576,rejectedBytes: 1048577,batchRows: 250,rejectedRows: 251,oldHeadsPreserved: true };
}

async function reportFileBoundary(database: pg.Pool, telemetry: CapacityTelemetry) {
  const identity = { ...selectionIdentity,tenantId: "capacity-file-boundary",principalId: "capacity-file-boundary" };
  const imports = new OfficialReportImports(database), bundleId = randomUUID();
  const metadata = { reportingPeriod: { startDate: "2026-09-01",endDate: "2026-09-30",provenance: "operator_asserted" as const },
    sourceAsOf: { value: "2026-10-01T00:00:00Z",provenance: "operator_asserted" as const } };
  for (const kind of ["agents","users","userAgents"] as const) await imports.stage(identity,{ bundleId },(async function* () {
    yield Buffer.from(schemaRegistry[kind].headers.join(",")+"\n"+officialLine(kind,0));
  })(),metadata);
  const prior = await imports.acceptBundle(identity,bundleId,await imports.bundle(identity,bundleId));
  const stage = async (over: boolean) => {
    const response = await fetch(`http://controller:8080/file-boundary?over=${Number(over)}`);
    assert.equal(response.status,200);
    let bytes = 0;
    try {
      const result = await imports.stage(identity,{ bundleId: randomUUID() },(async function* () {
        for await (const chunk of response.body!) { bytes += chunk.byteLength; yield Buffer.from(chunk); }
      })(),metadata);
      assert.equal(bytes,256*1024**2);
      return result;
    } finally { telemetry.write({ event: "file-boundary",over,bytes }); }
  };
  const exact = await stage(false);
  await imports.discard(identity,exact.id);
  const releasedAt = performance.now();
  while ((await database.query(`SELECT stored_bytes::text FROM official_usage_ingestions
    WHERE staging_id=$1`,[exact.id])).rows[0]?.stored_bytes!=="0") {
    assert.ok(performance.now()-releasedAt<600_000,"discarded exact-size staging must release its quota within ten minutes");
    await imports.sweep(identity.tenantId);
  }
  await assert.rejects(() => stage(true),{ code: "report_too_large" });
  assert.equal((await database.query("SELECT active_set_id FROM official_usage_state WHERE tenant_id=$1",[identity.tenantId])).rows[0].active_set_id,prior.setId);
  return { exactBytes: 256*1024**2,rejectedBytes: 256*1024**2+1,rows: 200_000,exact,oldPublication: prior.setId };
}

async function detailRetention(database: pg.Pool, telemetry: CapacityTelemetry, principal: string,
  exports: OfficialReportExports, identity: typeof selectionIdentity) {
  const selections = (await database.query(`SELECT id FROM data_read_selections
    WHERE tenant_id=$1 AND principal_id=$2 AND invalidated_at IS NULL LIMIT 100`,[fixtureTenant,principal])).rows;
  const reader = new InventoryQueries(database,"synthetic-capacity-query-cursor-key-32");
  for (const selection of selections) await reader.selections.invalidate(selection.id,identity);
  const activeExports = (await database.query(`SELECT id FROM data_exports WHERE tenant_id=$1 AND principal_id=$2
    AND status IN ('queued','building','ready') LIMIT 100`,[fixtureTenant,principal])).rows;
  for (const value of activeExports) {
    try { await exports.engine.cancel(value.id,identity); }
    catch (error) { telemetry.write({ event: "retention-export-release",id: value.id,error: String(error) }); }
  }
  const scopeRows = (await database.query(`SELECT id,source FROM data_scope_epochs WHERE tenant_id=$1 AND principal_id=$2
    AND source IN ('inventory_packages','inventory_power_platform','inventory_canonical') LIMIT 16`,[fixtureTenant,principal])).rows;
  const scopes = scopeRows.map(row => row.id);
  assert.ok(scopes.length > 0);
  let current = await reader.capture(identity,scopeRows.find(row => row.source==="inventory_packages")!.id);
  const ids = Array.from({ length: 20 },(_,i) => `package-${String(100+i).padStart(6,"0")}`);
  const protectedRows = await reader.exact(current.id,identity,ids);
  assert.deepEqual(protectedRows.map(row => row.identity),ids);
  const started = performance.now(), observer = await physicalWork(database,telemetry);
  let remaining: Record<string,string> = {}, slices = 0;
  try {
    do {
      if (current.expiresAt.getTime()<Date.now()+300_000) {
        const previous = current;
        current = await reader.capture(identity,scopeRows.find(row => row.source==="inventory_packages")!.id);
        await reader.selections.invalidate(previous.id,identity);
      }
      await capacityOperation(`retention:${++slices}`,async () => {
        await dataConnections(database).run(client => retainRecordData(client));
        const roots = (await database.query(`SELECT baseline_id,scope_id FROM inventory_roots
          WHERE scope_id=ANY($1::uuid[]) ORDER BY baseline_id LIMIT 33`,[scopes])).rows;
        assert.ok(roots.length<=32,"retention root inventory must not be truncated");
        const stages = new InventoryGenerations(database);
        for (const row of roots) await stages.gcSlice({ baselineId: row.baseline_id,scopeId: row.scope_id,tenantId: fixtureTenant } as InventoryRoot);
        for (const scope of scopes) {
          await stages.gcContent(scope,fixtureTenant);
          await stages.gcMetadata(scope,fixtureTenant);
        }
      });
      if (slices % 20 === 1) {
        remaining = (await database.query(`SELECT
          (SELECT count(*)::text FROM inventory_roots r JOIN inventory_memberships m ON m.baseline_id=r.baseline_id
            WHERE r.scope_id=ANY($1::uuid[]) AND m.valid_to_revision IS NOT NULL) AS intervals,
          (SELECT count(*)::text FROM data_generations WHERE scope_id=ANY($1::uuid[]) AND collected_at IS NOT NULL AND state<>'deleting') AS collected_quota_errors,
          (SELECT count(*)::text FROM data_generations WHERE scope_id=ANY($1::uuid[]) AND state NOT IN ('staging','validating')
            AND reserved_bytes<>byte_count) AS quota_mismatches,
          (SELECT count(*)::text FROM data_scope_epochs scope WHERE id=ANY($1::uuid[])
            AND generation_bytes<>(SELECT coalesce(sum(CASE WHEN state IN ('staging','validating') THEN reserved_bytes ELSE byte_count END),0)
              FROM data_generations WHERE scope_id=scope.id AND collected_at IS NULL)) AS scope_charge_mismatches,
          (SELECT coalesce(sum(reserved_bytes),0)::text FROM data_generations WHERE scope_id=ANY($1::uuid[]) AND collected_at IS NULL) AS reserved_bytes`,[scopes])).rows[0];
        remaining.unreferenced_keys = "unknown";
        if (remaining.intervals==="0") {
          let scanned = 0;
          remaining.unreferenced_keys = "0";
          for (const scopeId of scopes) {
            let after: { generation_id: string;identity: string } | undefined;
            let exhausted = false;
            while (performance.now()-started<600_000) {
            const page = (await database.query(`WITH keys AS MATERIALIZED (
              SELECT generation_id,identity FROM inventory_keys WHERE scope_id=$1
                AND ($2::uuid IS NULL OR (generation_id,identity COLLATE "C")>($2::uuid,$3::text COLLATE "C"))
              ORDER BY generation_id,identity COLLATE "C" LIMIT 250)
              SELECT k.*,NOT EXISTS(SELECT 1 FROM inventory_memberships m WHERE m.generation_id=k.generation_id AND m.identity=k.identity LIMIT 1 OFFSET 0)
                AND NOT EXISTS(SELECT 1 FROM unified_agent_memberships m WHERE m.source_generation_id=k.generation_id AND m.source_identity=k.identity LIMIT 1 OFFSET 0)
                AND NOT EXISTS(SELECT 1 FROM inventory_compaction_refs r WHERE r.source_generation_id=k.generation_id AND r.identity=k.identity LIMIT 1 OFFSET 0)
                AND NOT EXISTS(SELECT 1 FROM inventory_exact_heads h WHERE h.generation_id=k.generation_id AND h.identity=k.identity LIMIT 1 OFFSET 0) AS orphan FROM keys k
              ORDER BY generation_id,identity COLLATE "C"`,[scopeId,after?.generation_id ?? null,after?.identity ?? null])).rows;
            scanned += page.length;
            if (page.some(row => row.orphan)) { remaining.unreferenced_keys = "at_least_1"; break; }
            if (page.length<250) { exhausted = true; break; }
            after = page.at(-1) as typeof after;
            }
            if (remaining.unreferenced_keys!=="0") break;
            if (!exhausted) { remaining.unreferenced_keys = "unknown"; break; }
          }
          telemetry.write({ event: "retention-key-scan",scanned,result: remaining.unreferenced_keys,
            scope: "Bounded pages; zero is exact after exhausting the unchanged key set, a positive result is only a lower bound." });
        }
        telemetry.write({ event: "detail-retention",slices,elapsedMs: performance.now()-started,...remaining });
        await observer.flush();
        if (Object.entries(remaining).filter(([key]) => key!=="reserved_bytes").every(([,value]) => Number(value)===0)) break;
      }
    } while (performance.now()-started < 600_000);
    assert.equal(remaining.intervals,"0","obsolete membership intervals remain or their count is unavailable");
    assert.equal(remaining.unreferenced_keys,"0","the complete bounded orphan-key traversal did not prove zero within ten minutes");
    assert.equal(Number(remaining.collected_quota_errors),0);
    assert.equal(Number(remaining.quota_mismatches),0);
    assert.equal(remaining.scope_charge_mismatches,"0","scoped quota accounting must exactly match retained generation charges");
    assert.ok(performance.now()-started<=600_000);
    return { slices,elapsedMs: performance.now()-started,remaining,releasedSelections: selections.length,releasedExports: activeExports.length,
      quotaCoverage: "Collected reservations must be zero; retained-current reservations are reported, not assumed zero." };
  } finally {
    try {
      assert.deepEqual(await reader.exact(current.id,identity,ids),protectedRows);
      telemetry.write({ event: "retention-current-pin-preserved",rows: ids.length,selection: current.id });
      await reader.selections.invalidate(current.id,identity);
    } finally { await observer.close(); }
  }
}

async function fixedMutationProbe(database: pg.Pool, telemetry: CapacityTelemetry, graph: InventoryRoot, native: InventoryRoot,
  principal: string, count: number) {
  const reconciliation = new InventoryReconciliation(database);
  let input = capacityInput(principal, "inventory_canonical");
  await reconciliation.request(input, [graph, native]); await reconciliation.runNext(input, async () => {});
  const observer = await physicalWork(database, telemetry);
  try {
    const keys = Array.from({ length: 20 }, (_, index) => `package-${String(100+index).padStart(6, "0")}`);
    await observer.checkpoint();
    const start = (await database.query("SELECT pg_current_wal_insert_lsn()::text AS lsn")).rows[0].lsn;
    const stream = new StreamedInventory(database, new GraphPackagesClient(fixtureFetch(count, 7), packageInventoryReadPolicy));
    const root = await capacityOperation(`probe-${count}:native`, () =>
      stream.details(capacityInput(principal), "synthetic", keys, { authorize: async () => {} }));
    input = capacityInput(principal, "inventory_canonical");
    await capacityOperation(`probe-${count}:enqueue`, () => reconciliation.request(input, [root, native]));
    const canonical = await capacityOperation(`probe-${count}:canonical`, () => reconciliation.runNext(input, async () => {}));
    const wal = Number((await database.query("SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(),$1)::text AS bytes", [start])).rows[0].bytes);
    const physical = await observer.flush();
    assert.ok(physical.transactions>0 && physical.sequentialTuples+physical.indexTuples>0,"real read-work counters are required");
    const plan = (await database.query(`EXPLAIN (ANALYZE,BUFFERS,WAL,SETTINGS,FORMAT JSON)
      SELECT identity,generation_id FROM inventory_memberships WHERE baseline_id=$1 AND identity=ANY($2::text[])
        AND valid_from_revision<=$3 AND (valid_to_revision IS NULL OR valid_to_revision>$3)`,
    [root.baselineId, keys, root.revision])).rows;
    const result = { count, keys: 20, root, canonical, physical, wal, plan,
      coverage: "Committed physical writes include triggers/cascades; same-backend heap/index counter differences after BEGIN and before COMMIT exclude earlier pending scans. Rolled-back work is excluded. Each fixed probe starts after CHECKPOINT; WAL is a cluster delta including maintenance. Plan covers the exact membership seek." };
    telemetry.write({ event: "fixed-mutation-probe", ...result });
    return result;
  } finally { await observer.close(); }
}

async function capacityBackup(database: pg.Pool, telemetry: CapacityTelemetry) {
  const stages = new InventoryGenerations(database);
  const principal = "capacity-backup-churn", input = capacityInput(principal);
  let root = await new StreamedInventory(database, new GraphPackagesClient(fixtureFetch(1), packageInventoryReadPolicy))
    .graphCatalog(input, "synthetic", { authorize: async () => {} });
  while (database.idleCount) { const client = await database.connect(); client.release(true); }
  const previousMaximum = database.options.max;
  database.options.max = 2;
  const operator = new pg.Pool({ ...databaseSettings(), database: String(database.options.database),max: 1,
    application_name: "agent-control-capacity-operator" });
  // Two runtime slots, one snapshot operator, and one pg_dump connection keep the four-connection ceiling.
  try {
  let stop = false, writes = 0, writerFailure: unknown;
  const writer = (async () => {
    try {
      while (!stop) {
        root = await new StreamedInventory(database, new GraphPackagesClient(fixtureFetch(1, ++writes), packageInventoryReadPolicy))
          .details(capacityInput(principal), "synthetic", ["package-000000"], { authorize: async () => {} });
        if (writes % 10 === 0) await stages.gcSlice(root);
        await delay(100);
      }
    } catch (error) { writerFailure = error; }
  })();
  let counts;
  try { counts = await backup(operator, "/evidence/capacity.dump"); }
  finally { stop = true; await writer; }
  assert.ok(counts.package_record_rows.count >= 100_000);
  const bytes = statSync("/evidence/capacity.dump").size;
  while (database.idleCount) { const client = await database.connect(); client.release(true); }
  const target = `agentcontrol_restore_capacity_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  let restored;
  try {
    restored = await restore(operator, "/evidence/capacity.dump", target);
    const checked = new pg.Pool({ ...databaseSettings(), database: target, max: 1,application_name: "agent-control-capacity-operator" });
    try {
      const state = (await checked.query("SELECT mode,provider_work_enabled FROM operational_state WHERE singleton")).rows[0];
      assert.equal(state.mode, "maintenance"); assert.equal(state.provider_work_enabled, false);
      const schema = (await checked.query("SELECT fingerprint FROM app_schema WHERE singleton=true")).rows[0];
      telemetry.write({ event: "large-restore", target, bytes, writes, state, schema, tables: Object.keys(restored).length,
        churnFailure: writerFailure ? failure(writerFailure) : null });
      if (writerFailure) throw writerFailure;
      assert.ok(writes > 0);
      return { target, bytes, writes, state, schema, tables: Object.keys(restored).length };
    } finally { await checked.end(); }
  } finally {
    await operator.query(`DROP DATABASE IF EXISTS "${target}"`);
  }
  } finally { try { await operator.end(); } finally { database.options.max = previousMaximum; } }
}

async function highDegreeReports(database: pg.Pool, telemetry: CapacityTelemetry) {
  const identity = { ...selectionIdentity, tenantId: "capacity-high-degree", principalId: "capacity-high-degree" };
  const imports = new OfficialReportImports(database), bundleId = randomUUID();
  const metadata = { reportingPeriod: { startDate: "2026-09-01", endDate: "2026-09-30", provenance: "operator_asserted" as const },
    sourceAsOf: { value: "2026-10-01T00:00:00Z", provenance: "operator_asserted" as const } };
  for (const [kind, count] of [["users", 1], ["agents", 10_000], ["userAgents", 10_000]] as const) {
    const response = await fetch(`http://controller:8080/official?kind=${kind}&count=${count}&shape=one-user`);
    assert.equal(response.status, 200);
    await imports.stage(identity, { bundleId }, (async function* () {
      for await (const chunk of response.body!) yield Buffer.from(chunk);
    })(), metadata);
  }
  const accepted = await imports.acceptBundle(identity, bundleId, await imports.bundle(identity, bundleId));
  const reader = new LargeTenantUsersReports(database, "synthetic-capacity-query-cursor-key-32", 35);
  const selected = await reader.capture(identity, "delegated", "relationships", { username: "user-000000@example.invalid" });
  const expected = createHash("sha256"), observed = createHash("sha256");
  for (let i = 0; i < 10_000; i++) expected.update(`agent-${key(i)}\n`);
  let cursor: string | undefined, count = 0, requests = 0;
  do {
    const page = await reader.page(selected.id, identity, { limit: 100, cursor });
    assert.equal(page.counts.filtered, 10_000);
    const serialized = JSON.stringify(page); peakCheckpoint("response.serialize"); assert.ok(Buffer.byteLength(serialized) <= MiB);
    for (const row of page.value) { observed.update(`${(row as { agentId: string }).agentId}\n`); count++; }
    cursor = page.page.nextCursor ?? undefined; requests++;
  } while (cursor);
  assert.equal(count, 10_000); assert.equal(observed.digest("hex"), expected.digest("hex"));
  telemetry.write({ event: "high-degree-oracle", count, requests, accepted });
  return { count, requests, accepted };
}

async function detailSweeps(database: pg.Pool, telemetry: CapacityTelemetry, baseline: InventoryRoot, principal: string, native?: InventoryRoot) {
  const stages = new InventoryGenerations(database), reconciliation = new InventoryReconciliation(database);
  const lifecycle = new InventoryRuntime(database,async () => {});
  const sweeps = [];
  let current = baseline;
  const prepareInput = capacityInput(principal, "inventory_canonical");
  const roots = () => [current, ...(native ? [native] : [])];
  const scope = await reconciliation.request(prepareInput, roots());
  await reconciliation.runNext(prepareInput, async () => {});
  const observed = await physicalWork(database, telemetry), cancelled = new AbortController();
  let active: Promise<unknown> | undefined;
  const identity = { ...selectionIdentity, tenantId: fixtureTenant, principalId: principal };
  const reader = new InventoryQueries(database, "synthetic-capacity-query-cursor-key-32");
  const readerStop = new AbortController(), exportStop = new AbortController();
  const ids = Array.from({ length: 20 }, (_, i) => `package-${String(200+i).padStart(6, "0")}`);
  let pinned = await reader.capture(identity, current.scopeId);
  let pinnedValue = JSON.stringify(await reader.exact(pinned.id, identity, ids));
  const read = async (old: boolean) => {
    let requests = 0;
    const result = await capacityBackgroundLoop({ signal: readerStop.signal,intervalMs: 250,
      rejected: error => telemetry.write({ event: "reader-rejection",reader: old ? "detail-pinned" : "detail-current",error: failure(error) }),
      run: async () => {
      const started = performance.now();
      if (old && pinned.expiresAt.getTime() < Date.now()+1000) {
        telemetry.write({ event: "expired-pin-release", id: pinned.id });
        const replacement = await reader.capture(identity,current.scopeId);
        await capacityWithCleanup(async () => {
          const value = JSON.stringify(await reader.exact(replacement.id,identity,ids));
          pinned = replacement;pinnedValue = value;
        },async () => { if (pinned!==replacement) await reader.selections.invalidate(replacement.id,identity); });
      }
      const selected = old ? pinned : await reader.capture(identity, current.scopeId);
      await capacityWithCleanup(async () => {
        const rows = await reader.exact(selected.id, identity, ids);
        assert.equal(rows.length, 20); assert.deepEqual(rows.map(row => row.identity), ids);
        if (old) assert.equal(JSON.stringify(rows), pinnedValue);
      },async () => { if (!old) await reader.selections.invalidate(selected.id,identity); });
      telemetry.write({ event: "detail-reader", old, milliseconds: performance.now()-started, request: ++requests });
    } });
    return { old,requests,...result };
  };
  const exportReader = new LargeTenantUsersReports(database, "synthetic-capacity-query-cursor-key-32", 35);
  const exportEngine = new OfficialReportExports(exportReader, { tenantId: fixtureTenant, homeAccountId: principal,
    username: "capacity@example.invalid", displayName: "Synthetic capacity" }, "synthetic-capacity-query-cursor-key-32");
  const exportWork = async () => {
    let bytes = 0,chunks = 0;
    const result = await capacityBackgroundLoop({ signal: readerStop.signal,intervalMs: 0,
      rejected: error => telemetry.write({ event: "detail-background-rejection",role: "export",error: failure(error) }),
      run: async () => {
        const id = await exportEngine.create(identity, { selectionId: pinned.id, kind: "graph_packages" });
        await capacityWithCleanup(async () => {
          await exportEngine.build(id, identity, "graph_packages", exportStop.signal);
          for await (const chunk of exportEngine.engine.download(id, identity, exportStop.signal)) {
            assert.ok(chunk.length <= 262144);bytes += chunk.length;chunks++;
            await delay(25);
          }
          telemetry.write({ event: "detail-export-completed",id,bytes,chunks });
        },() => exportEngine.engine.cancel(id,identity));
      } });
    return { bytes,chunks,...result };
  };
  const gc = async () => {
    let slices = 0,inventoryCollections = 0;
    const result = await capacityBackgroundLoop({ signal: readerStop.signal,intervalMs: 0,
      rejected: error => telemetry.write({ event: "detail-background-rejection",role: "gc",error: failure(error) }),
      run: async () => {
      await capacityOperation(`detail-gc:${++slices}`, async () => {
        await stages.gcSlice(current);
        inventoryCollections += Number(await lifecycle.collect());
        await dataConnections(database).run(client => retainRecordData(client));
      });
    } });
    assert.ok(inventoryCollections>0,"the real inventory lifecycle collector must run");
    return { slices,inventoryCollections,...result };
  };
  const background = Promise.allSettled([read(true), read(false), exportWork(), gc()]);
  let successful = false;
  let releaseOverlap = () => {};
  let lastPublication = performance.now(), maximumPublicationGapMs = 0, sawActivePending = false;
  try {
  for (let sweep = 1; sweep <= 2; sweep++) {
    const producerStartedAt = performance.now();
    const stream = new StreamedInventory(database, new GraphPackagesClient(fixtureFetch(100_000,10+sweep,false,"sparse"), packageInventoryReadPolicy));
    let written = 0, closed = 0, changed = 0, starts = 0, publications = 0;
    const begin = (await database.query("SELECT pg_current_wal_insert_lsn()::text AS lsn")).rows[0].lsn;
    let worker: Promise<unknown> | undefined, workerFailure: unknown;
    let reachedOverlap!: () => void, overlapHeld = false;
    const overlapReady = new Promise<void>(resolve => { reachedOverlap = resolve; });
    const overlapReleased = new Promise<void>(resolve => { releaseOverlap = resolve; });
    for (let batch = 0; batch < 5000; batch++) {
      if (workerFailure) throw workerFailure;
      if (batch === 1) {
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([overlapReady, active!.then(() => {
            if (!overlapHeld) throw workerFailure ?? new Error("capacity_overlap_worker_finished_before_barrier");
          }), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("capacity_overlap_barrier_deadline")), 30_000); })]);
        } finally { clearTimeout(timer); }
      }
      const values = Array.from({ length: 20 }, (_, i) => packageValue(batch*20+i, 10+sweep));
      const root = await capacityOperation(`native:${sweep}:${batch}`, () =>
        stream.details(capacityInput(principal), "synthetic", values.map(value => value.id), { authorize: async () => {} }));
      current = root; written += root.inserted; closed += root.closed; changed += root.changed;
      const input = capacityInput(principal, "inventory_canonical");
      await capacityOperation(`enqueue:${sweep}:${batch}`, () => reconciliation.request(input, roots()));
      // Claim promptly, as the real worker does. The first publication barrier
      // holds one captured batch until the next real batch creates pending work.
      if (!worker) {
        starts++;
        const overlap = starts === 1;
        let authorizations = 0;
        worker = capacityOperation(`canonical:${sweep}:${starts}`, () => reconciliation.runNext(input, async signal => {
          if (overlap && ++authorizations === 2) {
            overlapHeld = true; reachedOverlap();
            telemetry.write({ event: "detail-publication-barrier", sweep, batch, at: performance.now(),
              scope: "Real claimed worker has staged its captured changes; no database connection/transaction is held while the next actual source batch creates pending work." });
            await overlapReleased;
            signal.throwIfAborted();
          }
        }, cancelled.signal)).then(result => {
          if (result) {
            const now = performance.now();
            maximumPublicationGapMs = Math.max(maximumPublicationGapMs, now-Math.max(lastPublication,producerStartedAt)); lastPublication = now;
            publications++; telemetry.write({ event: "canonical-publication", sweep, batch, at: now, result });
          }
        }).catch(error => { workerFailure = error; telemetry.write({ event: "canonical-failure", sweep, batch, error: String(error) }); })
          .finally(() => { worker = undefined; });
        active = worker;
      }
      telemetry.write({ event: "detail-batch", sweep, batch, keys: 20, inserted: root.inserted, closed: root.closed, changed: root.changed });
      assertCapacityPublicationProgress(performance.now()-Math.max(lastPublication,producerStartedAt));
      if (batch % 20 === 0 || batch === 1) {
        const state = (await database.query(`SELECT active_id IS NOT NULL AS active,pending_inputs IS NOT NULL AS pending,
          (SELECT count(*)::int FROM data_generations WHERE scope_id=$1 AND state IN ('staging','validating')) AS active_jobs,
          (SELECT count(*)::int FROM data_generations WHERE scope_id=$1 AND state='cancelled') AS cancellations
          FROM inventory_reconciliation WHERE scope_id=$1`, [scope.scopeId])).rows[0];
        assert.ok(state.active_jobs <= 1); assert.equal(state.cancellations, 0);
        sawActivePending ||= state.active && state.pending;
        telemetry.write({ event: "detail-queue-progress", sweep, batch, ...state,
          producerStartedAt,publicationGapMs: performance.now()-Math.max(lastPublication,producerStartedAt) });
        if (batch === 1) {
          try {
            assert.ok(overlapHeld && state.active && state.pending && state.active_jobs === 1,
              "a real prepared worker must retain the newly enqueued safe source update");
          } finally { releaseOverlap(); }
        }
        if (batch%100===0) {
          await capacityOperation(`gc:${sweep}:${batch}`, () => stages.gcSlice(current));
          await observed.flush();
        }
      }
    }
    await worker;
    if (workerFailure) throw workerFailure;
    const stoppedAt = performance.now();
    const input = capacityInput(principal, "inventory_canonical");
    await capacityOperation(`enqueue-final:${sweep}`, () => reconciliation.request(input, roots()));
    await capacityOperation(`canonical-final:${sweep}`, () => reconciliation.runNext(input, async () => {}, cancelled.signal));
    const final = (await database.query("SELECT active_id,pending_inputs,published_inputs FROM inventory_reconciliation WHERE scope_id=$1", [scope.scopeId])).rows[0];
    assert.equal(final.active_id, null); assert.equal(final.pending_inputs, null);
    assert.ok(final.published_inputs.some((root: { scopeId: string; revision: string }) =>
      root.scopeId === current.scopeId && String(root.revision) === current.revision));
    const convergenceMs = performance.now()-stoppedAt;
    const valuesDigest = createHash("sha256"), expectedValues = createHash("sha256");
    let verifiedValues = 0;
    const mismatches: { id: string;expectedId: string;actual: string }[] = [];
    for (let offset=0;offset<100_000;offset+=100) {
      const ids = Array.from({ length: 100 },(_,i) => `package-${key(offset+i)}`);
      const rows = (await database.query(`SELECT r.native_id,r.residual->>'longDescription' AS detail
        FROM inventory_memberships m JOIN package_record_rows r ON r.generation_id=m.generation_id AND r.identity=m.identity
        WHERE m.baseline_id=$1 AND m.valid_from_revision<=$2 AND (m.valid_to_revision IS NULL OR m.valid_to_revision>$2)
          AND m.identity=ANY($3::text[]) ORDER BY r.native_id COLLATE "C"`,
      [current.baselineId,current.revision,ids])).rows;
      assert.equal(rows.length,100);
      for (const [index,row] of rows.entries()) {
        const expected = `${ids[index]}\0Synthetic detail value ${10+sweep}\n`;
        const actual = `${row.native_id}\0${row.detail}\n`;
        expectedValues.update(expected); valuesDigest.update(actual);
        if (actual===expected) verifiedValues++;
        else if (mismatches.length<8) mismatches.push({ id: row.native_id,expectedId: ids[index],actual: String(row.detail).slice(0,512) });
      }
    }
    const checksum = valuesDigest.digest("hex"),expectedChecksum = expectedValues.digest("hex");
    const wal = Number((await database.query("SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(),$1)::text AS bytes", [begin])).rows[0].bytes);
    const result = { sweep, batches: 5000, keys: 100_000, written, closed, changed, starts, publications, wal,
      convergenceMs, maximumPublicationGapMs, sawActivePending,verifiedValues,checksum,expectedChecksum,mismatches,
      canonicalScheduling: "claim-after-batch-when-idle",initialOverlapBatches: 2,producerStartedAt };
    telemetry.write({ event: "detail-sweep", ...result }); sweeps.push(result);
  }
  assert.ok(sweeps.every(sweep => sweep.verifiedValues===100_000 && sweep.checksum===sweep.expectedChecksum),
    "every key in both complete sweeps must retain the newly supplied detail value");
  assert.ok(sawActivePending, "safe detail churn must actually overlap active and pending work");
  assert.ok(maximumPublicationGapMs <= 60_000, "canonical publication cadence exceeds sixty seconds");
  assert.ok(sweeps.every(sweep => sweep.convergenceMs <= 300_000), "latest vector convergence exceeds five minutes");
  successful = true;
  return sweeps;
  } finally {
    releaseOverlap();
    readerStop.abort();
    if (!successful) exportStop.abort(new Error("capacity_detail_cleanup"));
    cancelled.abort(new Error("capacity_detail_cleanup"));
    await active;
    const concurrent = await background;
    telemetry.write({ event: "detail-concurrent-results", results: concurrent.map(result =>
      result.status === "fulfilled" ? result : { status: result.status, reason: failure(result.reason) }) });
    await observed.close();
    if (successful && concurrent.some(result => result.status === "rejected" || result.value.rejections>0)) {
      throw new Error("capacity_detail_concurrent_failure");
    }
  }
}

async function heartbeatWorkload(database: pg.Pool, telemetry: CapacityTelemetry, graph?: InventoryRoot) {
  const stream = new StreamedInventory(database);
  let attempts = 0, renewals = 0, validationRenewals = 0, validating = false, leaseId: string | undefined;
  let validationSignal: AbortSignal | undefined;
  const renew = stream.stages.generations.renew.bind(stream.stages.generations);
  stream.stages.generations.renew = async (...args) => {
    await renew(...args); renewals++; validationRenewals += Number(validating); leaseId = args[0].id;
    telemetry.write({ event: "heartbeat", renewals, at: Date.now(), owner: args[0].owner, version: args[0].version, epoch: args[0].epoch });
  };
  const validate = stream.stages.validate.bind(stream.stages);
  stream.stages.validate = async lease => {
    await validate(lease);
    validating = true;
    telemetry.write({ event: "validation-idle-start",at: Date.now(),leaseId: lease.id,renewals });
    try {
      await delay(20_500,undefined,{ signal: validationSignal });
      const state = (await database.query("SELECT state,row_count,batch_count FROM data_generations WHERE id=$1",[lease.id])).rows[0];
      assert.equal(state.state,"validating"); assert.equal(state.row_count,0); assert.equal(state.batch_count,0);
      assert.ok(validationRenewals>=1);
      telemetry.write({ event: "validation-idle-end",at: Date.now(),leaseId: lease.id,renewals,validationRenewals,state });
    } finally { validating = false; }
  };
  const provider = new GraphPackagesClient(async (url, init) => {
    const target = new URL("http://controller:8080/provider");
    target.searchParams.set("count", "0"); target.searchParams.set("upstream", String(url));
    if (++attempts === 1) target.searchParams.set("retry", "600");
    return fetch(target, { ...init, headers: {}, redirect: "error" });
  }, packageInventoryReadPolicy);
  const stopped = new AbortController();
  const reader = new InventoryQueries(database, "synthetic-capacity-query-cursor-key-32");
  const identity = { ...selectionIdentity, tenantId: fixtureTenant, principalId: "capacity-main" };
  let pin = graph ? await reader.capture(identity, graph.scopeId) : undefined;
  const ids = Array.from({ length: 20 }, (_, i) => `package-${String(200+i).padStart(6, "0")}`);
  const readers = Array.from({ length: 12 }, async (_, index) => {
    let requests = 0, failures = 0;
    while (!stopped.signal.aborted) {
      try {
        if (pin && graph) {
          if (pin.expiresAt.getTime() < Date.now()+2000) pin = await reader.capture(identity, graph.scopeId);
          assert.equal((await reader.exact(pin.id, identity, ids)).length, 20);
        } else await database.query("SELECT pg_sleep(0.01)");
        requests++;
      } catch (error) { failures++; telemetry.write({ event: "heartbeat-reader-error", index, error: failure(error) }); }
      await delay(20);
    }
    return { index, requests, failures, dataset: graph ? 100_000 : 0 };
  });
  const started = Date.now();
  try {
    await stream.stages.execute(capacityInput("capacity-idle"), { domain: "packages", mode: "baseline", channel: "catalog" }, async (lease, signal) => {
      leaseId = lease.id; validationSignal = signal;
      for await (const page of provider.catalogPages("synthetic", { signal, visit: token => stream.stages.visit(lease, token) })) {
        await stream.stages.acceptPage(lease, page, 0);
      }
    }, { authorize: async () => {} });
  assert.ok(Date.now() - started >= 600_000); assert.ok(renewals >= 30);
  const long = (await database.query("SELECT state,row_count,batch_count FROM data_generations WHERE id=$1", [leaseId])).rows[0];
  assert.equal(long.state, "published"); assert.equal(long.row_count, 0); assert.equal(long.batch_count, 0);
  const cancelled = new AbortController(); let cancelLease!: GenerationLease;
  let cancelAttempts = 0, ready!: () => void, rejectReady!: (error: unknown) => void;
  const waiting = new Promise<void>((resolve, reject) => { ready = resolve; rejectReady = reject; });
  const cancelProvider = new GraphPackagesClient(async (url, init) => {
    cancelAttempts++;
    const target = new URL("http://controller:8080/provider");
    target.searchParams.set("count", "0"); target.searchParams.set("upstream", String(url)); target.searchParams.set("retry", "600");
    const response = await fetch(target, { ...init, headers: {}, redirect: "error" });
    assert.equal(response.status, 429); ready(); return response;
  }, packageInventoryReadPolicy);
  const countBefore = renewals;
  const pending = stream.stages.execute(capacityInput("capacity-cancel"), { domain: "packages", mode: "baseline", channel: "catalog" },
    async (lease, signal) => {
      cancelLease = lease;
      for await (const _page of cancelProvider.catalogPages("synthetic", { signal, visit: token => stream.stages.visit(lease, token) })) {
        throw new Error("cancelled_retry_unexpected_page");
      }
    },
    { authorize: async () => {}, signal: cancelled.signal });
  void pending.catch(rejectReady);
  await waiting;
  await delay(1000); cancelled.abort(new Error("capacity_cancel"));
  await assert.rejects(pending);
  await delay(21_000);
  assert.equal(renewals, countBefore);
  const row = (await database.query("SELECT state,lease_until,row_count FROM data_generations WHERE id=$1", [cancelLease.id])).rows[0];
  assert.equal(row.state, "cancelled"); assert.equal(row.row_count, 0);
  assert.equal(cancelAttempts, 1);
  return { elapsedMs: Date.now() - started, leaseId, renewals, validationRenewals, attempts, long, cancelAttempts, cancelled: row,
    readerDataset: graph ? 100_000 : 0 };
  } finally {
    stopped.abort();
    telemetry.write({ event: "heartbeat-readers", results: await Promise.allSettled(readers) });
  }
}

async function residualBoundary(database: pg.Pool) {
  const stages = new DataGenerations(database), input = generationInput({ reserveBytes: 128*MiB,
    scope: { tenantId: fixtureTenant, kind: "principal", principalId: "capacity-residual", tokenMode: "delegated", source: "directory", selector: "complete" } });
  const residual = (index: number) => {
    const text = Buffer.alloc(262144 - Buffer.byteLength('{"value": ""}'));
    let state = 0x12345678 ^ index;
    for (let i = 0; i < text.length; i++) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
      let byte = 33+(state >>> 0)%92;
      if (byte === 34 || byte === 92) byte = 35;
      text[i] = byte;
    }
    return { value: text.toString("ascii") };
  };
  const previous = await stages.execute(input, async lease => {
    for (let i = 0; i < 200; i++) {
      const value = residual(i);
      assert.equal(Buffer.byteLength(`{"value": "${value.value}"}`), 262144);
      await stages.append(lease, "directory", i, [directoryRecord(userId(i), { residual: value })]);
    }
    await stages.validate(lease, { rows: 200, children: 0, batches: 200, pages: 0, wireRows: 0 });
    await stages.publish(lease); return { generationId: lease.id, scopeId: lease.scopeId };
  });
  await assert.rejects(() => stages.execute(input, async lease => {
    await stages.append(lease, "directory", 0, [directoryRecord(userId(200), { residual: { value: residual(200).value + "x" } })]);
  }),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "data_residual_bytes"));
  assert.equal((await database.query("SELECT generation_id FROM data_generation_heads WHERE scope_id=$1", [previous.scopeId])).rows[0].generation_id, previous.generationId);
  return { exactRows: 200, residualBytes: 262144, compactWireBytes: 262143, encoding: "PostgreSQL normalized JSONB text UTF-8",
    rejectedBytes: 262145, partialPublication: false, previous };
}

async function workerTakeover(database: pg.Pool, telemetry: CapacityTelemetry) {
  while (database.idleCount) { const client = await database.connect(); client.release(true); }
  const children: ReturnType<typeof fork>[] = [];
  const startWorker = () => {
    const child = fork(fileURLToPath(new URL("./large-tenant-capacity.ts", import.meta.url)), ["--lease-worker"], {
    execArgv: ["--max-old-space-size=768", "--trace-gc-nvp", "--import", "tsx"], stdio: ["ignore", "inherit", "inherit", "ipc"],
    env: { ...process.env, PGDATABASE: String(database.options.database), PGUSER: "agentcontrol_app", PGPASSWORD: process.env.APP_PGPASSWORD },
    });
    children.push(child); return child;
  };
  const receive = (child: ReturnType<typeof fork>) => new Promise<GenerationLease>((resolve, reject) => {
    child.once("message", value => resolve(value as GenerationLease));
    child.once("error", reject); child.once("exit", code => reject(new Error(`lease_worker_early_exit:${code}`)));
  });
  try {
  const child = startWorker(), lease = await receive(child);
  const start = Date.now();
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve =>
    child.once("exit", (code, signal) => resolve({ code, signal })));
  assert.ok(child.pid); assert.equal(child.kill("SIGTERM"), true);
  const exit = await exited;
  assert.equal(exit.signal, "SIGTERM");
  telemetry.write({ event: "owned-worker-death", pid: child.pid, lease, exit });
  await delay(61_000);
  const stages = new DataGenerations(database);
  await assert.rejects(() => stages.renew(lease), /data_writer_fenced/);
  while (database.idleCount) { const client = await database.connect(); client.release(true); }
  const restarted = startWorker(), successor = await receive(restarted);
  assert.notEqual(successor.owner, lease.owner);
  await assert.rejects(() => stages.connections.run(client => stages.fence(client, lease)), /data_writer_fenced/);
  const old = (await database.query("SELECT state FROM data_generations WHERE id=$1", [lease.id])).rows[0].state;
  assert.equal(old, "failed");
  await stages.abort(successor, true);
  const restartExit = new Promise(resolve => restarted.once("exit",(code,signal) => resolve({code,signal})));
  assert.ok(restarted.pid); assert.notEqual(restarted.pid,child.pid); assert.equal(restarted.kill("SIGTERM"),true);
  return { pid: child.pid, exit,restartedPid: restarted.pid,restartExit: await restartExit,realElapsedMs: Date.now()-start,
    expiredLease: lease.id, successor: successor.id, oldOwnerRejected: true };
  } finally {
    for (const child of children) if (child.exitCode===null && child.signalCode===null) {
      const exited = new Promise(resolve => child.once("exit",resolve));
      child.kill("SIGTERM"); await exited;
    }
  }
}

async function wideDirectory(database: pg.Pool, telemetry: CapacityTelemetry) {
  const stages = new DataGenerations(database);
  const input = capacityInput("capacity-wide", "directory");
  return stages.execute(input, async (lease, signal) => {
    let ordinal = 0;
    for (let offset = 0; offset < 10_000; offset += 100) {
      signal.throwIfAborted();
      const users = Array.from({ length: 100 }, (_, i) => directoryRecord(userId(offset+i), { plan_count: 500 }));
      await stages.append(lease, "directory", ordinal++, users);
      for (let user = offset; user < offset+100; user++) {
        for (let start = 0; start < 500; start += 250) {
          const plans: PlanRecord[] = Array.from({ length: 250 }, (_, i) => ({
            identity: `${userId(user)}:plan-${start+i}`, user_id: userId(user), plan_id: `plan-${start+i}`,
            service: "synthetic", display_name: `Plan ${start+i}`, state: "unknown", capability_status: null,
            assigned_at: null, residual: {},
          }));
          await stages.append(lease, "plans", ordinal++, plans);
        }
      }
      telemetry.write({ event: "wide-progress", users: offset+100, plans: (offset+100)*500 });
    }
    await stages.validate(lease, { rows: 10_000, children: 5_000_000, batches: ordinal, pages: 0, wireRows: 0 });
    const revision = await stages.publish(lease);
    return { users: 10_000, children: 5_000_000, batches: ordinal, revision };
  });
}

async function deepInventory(database: pg.Pool, telemetry: CapacityTelemetry) {
  const stream = new StreamedInventory(database,new GraphPackagesClient(fixtureFetch(100,0,false,"sparse",10_000),packageInventoryReadPolicy));
  const baseline = await stream.graphCatalog(capacityInput("capacity-deep"),"synthetic",{ authorize: async () => {} });
  let failed = 0, succeeded = 0;
  const errors: unknown[] = [];
  for (let i = 0; i < 100; i++) {
    const previous = (await database.query("SELECT revision::text FROM inventory_roots WHERE scope_id=$1 AND current",[baseline.scopeId])).rows[0].revision;
    try {
      await stream.details(capacityInput("capacity-deep"),"synthetic",[`package-${key(i)}`],{ authorize: async () => {} });
      succeeded++;
    } catch (error) {
      failed++; if (errors.length<8) errors.push(failure(error));
      assert.equal((await database.query("SELECT revision::text FROM inventory_roots WHERE scope_id=$1 AND current",[baseline.scopeId])).rows[0].revision,previous);
      telemetry.write({ event: "deep-rejection",agent: i,requestedChildren: 10_000,error: failure(error) });
    }
    telemetry.write({ event: "deep-progress",agents: i+1,requestedChildren: (i+1)*10_000,succeeded,failed });
  }
  const current = (await database.query("SELECT baseline_id,revision::text FROM inventory_roots WHERE scope_id=$1 AND current",[baseline.scopeId])).rows[0];
  const storedChildren = Number((await database.query(`SELECT count(*)::text AS n FROM inventory_memberships m
    JOIN inventory_facts f ON f.generation_id=m.generation_id AND f.identity=m.identity
    WHERE m.baseline_id=$1 AND m.valid_from_revision<=$2 AND (m.valid_to_revision IS NULL OR m.valid_to_revision>$2)
      AND f.kind='element' AND f.payload->>'elementType'='DeclarativeCopilots'`,[current.baseline_id,current.revision])).rows[0].n);
  telemetry.write({ event: "deep-result",succeeded,failed,storedChildren,oldBaselinePreserved: current.baseline_id===baseline.baselineId,
    oldRevisionPreserved: current.revision===baseline.revision,errors });
  assert.equal(succeeded,100,`100-agent/10000-observed-child envelope rejected ${failed} agents; retained metadata also consumes the frozen fact quota`);
  assert.equal(storedChildren,1_000_000);
  return { agents: 100,children: storedChildren,succeeded,failed };
}

async function reportHistory(database: pg.Pool, telemetry: CapacityTelemetry) {
  const identity = { ...selectionIdentity, tenantId: "capacity-history", principalId: "capacity-history" };
  const imports = new OfficialReportImports(database);
  const reader = new LargeTenantUsersReports(database, "synthetic-capacity-history-cursor-key-32", 35);
  const accepted: string[] = [];
  const pending: string[] = [];
  for (let set = 0; set < 32; set++) {
    const bundleId = randomUUID();
    for (const kind of ["agents", "users", "userAgents"] as const) {
      const metadata = { reportingPeriod: { startDate: "2026-09-01", endDate: "2026-09-30", provenance: "operator_asserted" as const },
        sourceAsOf: { value: new Date(Date.parse("2026-10-01T00:00:00Z")+set*1000).toISOString(), provenance: "operator_asserted" as const } };
      await imports.stage(identity, { bundleId }, (async function*() {
        yield Buffer.from(schemaRegistry[kind].headers.join(",")+"\n"+officialLine(kind, 0, set));
      })(), metadata);
    }
    pending.push(bundleId);
    if (pending.length === 2) {
      const previews = await Promise.all(pending.map(id => imports.bundle(identity, id)));
      const attempts = await Promise.allSettled(pending.map((id, index) => imports.acceptBundle(identity, id, previews[index])));
      for (const [index, attempt] of attempts.entries()) {
        telemetry.write({ event: "history-concurrent-acceptance", index: set-1+index,
          result: attempt.status === "fulfilled" ? attempt : { status: attempt.status, reason: failure(attempt.reason) } });
        const result = attempt.status === "fulfilled" ? attempt.value
          : await imports.acceptBundle(identity, pending[index], await imports.bundle(identity, pending[index]));
        accepted.push(result.setId);
      }
      pending.length = 0;
    }
  }
  const pin = await reader.capture(identity, "delegated", "history");
  const page = await reader.page(pin.id, identity, { limit: 100 });
  assert.equal(page.counts.total, 32);
  const old = await reader.capture(identity, "delegated", "official_users", { setId: accepted[0] });
  const exportEngine = new OfficialReportExports(reader, { tenantId: identity.tenantId, homeAccountId: identity.principalId,
    username: "history@example.invalid", displayName: "History" }, "synthetic-capacity-history-cursor-key-32");
  const exportId = await exportEngine.create(identity, { selectionId: old.id, kind: "official_users" });
  await exportEngine.build(exportId, identity, "official_users");
  const correction = randomUUID();
  for (const kind of ["agents", "users", "userAgents"] as const) {
    await imports.stage(identity, { bundleId: correction, correctionOfSetId: accepted[0] }, (async function* () {
      yield Buffer.from(schemaRegistry[kind].headers.join(",")+"\n"+officialLine(kind, 0, 100));
    })(), { reportingPeriod: { startDate: "2026-09-01", endDate: "2026-09-30", provenance: "operator_asserted" },
      sourceAsOf: { value: "2026-10-01T00:00:00Z", provenance: "operator_asserted" } });
  }
  const corrected = await imports.acceptBundle(identity, correction, await imports.bundle(identity, correction));
  telemetry.write({ event: "history-nonactive-correction", corrected, pinned: old.id, exportId });
  await assert.rejects(() => reader.page(pin.id, identity));
  const confirmation = await imports.confirmPreview(identity, accepted[0], "delete");
  await imports.confirm(identity, confirmation);
  await assert.rejects(() => reader.page(pin.id, identity));
  return { sets: 32, corrected, exportId, deletedNonActive: accepted[0], historyPinInvalidated: true };
}
