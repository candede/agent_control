import { createHmac, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import session from "express-session";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { inventoryInput, packageRecord } from "../../scripts/inventoryFixtures.js";
import { InventoryGenerations, inventorySelector } from "../db/inventoryGenerations.js";
import { InventoryReconciliation } from "../services/inventoryReconciliation.js";
import { PackageRefreshJobs } from "../db/packageRefreshJobs.js";
import { publishPackageReadback, readPackageInventoryGeneration } from "../db/packageControls.js";
import { createApp } from "../app.js";
import { config } from "../config.js";
import { completeInventoryJob, inventoryJobInput, InventoryRuntime } from "../services/inventoryRuntime.js";
import { StreamedInventory } from "../services/streamedInventory.js";
import { GraphPackagesClient } from "../services/graphPackages.js";
import { packageInventoryRecord, powerPlatformInventoryRecord } from "../services/inventoryRecordProjection.js";
import { OfficialReportExports } from "../services/officialReportExports.js";
import { LargeTenantUsersReports } from "../services/largeTenantUsersReports.js";
import { reportIdentity } from "../services/reportIdentity.js";
import { InventoryQueries } from "../db/inventoryQueries.js";
import { capabilities } from "../services/capabilities.js";
import { AppError } from "../errors.js";
import { parse as parseCsv } from "csv-parse/sync";
import type { PowerPlatformResource } from "../types/powerPlatformInventory.js";
import { unifiedAgentRecordId } from "../types/unifiedAgents.js";
import { AgentIdentityRepository } from "../db/agentIdentity.js";
import { LiveInventory } from "../db/liveInventory.js";
import { AgentInvestigationsService } from "../services/agentInvestigations.js";
import { verifiedAgentIdentityClientIdProvenance } from "../types/agentInvestigations.js";
import { dataConnections } from "../db/dataConnections.js";
import { InventoryMutationStages } from "../db/inventoryMutationStages.js";
import pg from "pg";

function forbidAuthorityWrites(database: pg.Pool) {
  const clients = new Map<pg.PoolClient, () => void>();
  let count = 0;
  const acquire = (client: pg.PoolClient) => {
    if (clients.has(client)) return;
    const original = client.query.bind(client);
    const spy = vi.spyOn(client, "query").mockImplementation(((...args: unknown[]) => {
      const text = typeof args[0] === "string" ? args[0] : (args[0] as { text: string }).text;
      count++;
      const writes = [...text.matchAll(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+(?:public\.)?(?:inventory_(?:roots|revisions|memberships|exact_heads|canonical\w*|control_pending|native_control_pending|records|facts|attempts|keys|changes|reconciliation\w*|frontier|candidate_edges)|data_(?:generations|generation_heads|scope_epochs)|(?:package|power_platform)_record_rows|unified_agent_(?:rows|memberships)|package_inventory_(?:resources|snapshots)|(?:package|power_platform)_refresh_jobs|jobs|job_items)\b/gi)];
      // The existing report/people read pins may initialize their metadata-only observer anchors.
      const observerPin = writes.length === 1 && /^INSERT INTO data_scope_epochs\(/.test(text.trim())
        && /'(?:user_sources|official_history)','complete'/.test(text) && /DO NOTHING RETURNING id\s*$/.test(text);
      if (writes.length && !observerPin) {
        throw new Error("Inventory GET attempted to mutate source, canonical, control, or job authority");
      }
      if (/\b(?:power_platform_inventory_(?:snapshots|resources)|unified_agents|unified_agent_sources|package_detail_cache)\b/i.test(text)) {
        throw new Error("Inventory GET attempted a removed whole-inventory read");
      }
      return Reflect.apply(original, client, args);
    }) as typeof client.query);
    clients.set(client, () => spy.mockRestore());
  };
  database.on("acquire", acquire);
  const restore = () => {
    database.removeListener("acquire", acquire);
    for (const cleanup of clients.values()) cleanup();
    clients.clear();
  };
  onTestFinished(restore);
  return { count: () => count, restore };
}

vi.hoisted(() => {
  delete process.env.TENANTS_JSON_FILE;
  process.env.TENANTS_JSON = JSON.stringify([{
    tenantId: "11111111-1111-1111-1111-111111111111", clientId: "22222222-2222-4222-8222-222222222222",
    clientSecret: "synthetic-inventory-secret", domains: ["example.invalid"],
  }]);
  process.env.SESSION_SECRET = "synthetic-inventory-session-secret";
});

describe("inventory HTTP selected-read boundary", () => {
  let fixture: Awaited<ReturnType<typeof testDatabase>>;
  let application: ReturnType<typeof createApp>, server: Server, base: string, cookie: string;
  const principalId = randomUUID();
  const widePublisher = "界".repeat(4096);
  beforeAll(async () => {
    fixture = await testDatabase();
    const stages = new InventoryGenerations(fixture.runtime);
    const sourceInput = inventoryInput(principalId);
    sourceInput.scope.tenantId = config.tenants[0].tenantId;
    const source = await stages.execute(sourceInput, { domain: "packages", mode: "baseline", channel: "catalog" }, async lease => {
      const records = Array.from({ length: 101 }, (_, index) => packageRecord(index));
      records[1] = packageInventoryRecord({ id: "package-000001", displayName: "Agent 1", isBlocked: false, publisher: widePublisher });
      records[0] = packageInventoryRecord({ id: "package-000000", displayName: "Agent 0", isBlocked: false,
        availableTo: "specificUsersAndGroups", allowedUsersAndGroups: [
          { resourceId: "33333333-3333-4333-8333-333333333333", resourceType: "group" },
        ], acquireUsersAndGroups: [],
        supportedHosts: ["Teams", "Web"], elementDetails: ["DeclarativeCopilots", "CustomEngineAgents"].map((elementType, group) => ({
          elementType, elements: Array.from({ length: 50 + group }, (_, index) => ({
            id: `child-${group}-${index}`, definition: JSON.stringify({ title: `Child ${index}` }),
          })),
        })) });
      await stages.visit(lease, "first");
      await stages.appendBounded(lease, records);
      await stages.acceptPage(lease, { token: "first", nextToken: null, records, rawCount: 101, expectedCount: 101, page: 1 }, 101);
    }, { authorize: async () => {} });
    const reconciliation = new InventoryReconciliation(fixture.runtime);
    const input = inventoryInput(principalId, "canonical");
    input.scope.tenantId = config.tenants[0].tenantId;
    await reconciliation.request(input, [source]);
    await reconciliation.runNext(input, async () => {});
    application = createApp(fixture.runtime);
    const id = randomUUID();
    const signature = createHmac("sha256", config.sessionSecret).update(id).digest("base64").replace(/=+$/g, "");
    await new Promise<void>((resolve, reject) => application.store.set(id, {
      cookie: new session.Cookie({ maxAge: 600_000 }),
      tenantId: config.tenants[0].tenantId, accountId: principalId, clientId: config.tenants[0].clientId,
      rolesValidatedAt: Date.now(), csrfToken: "inventory-csrf",
      user: { tenantId: config.tenants[0].tenantId, homeAccountId: principalId,
        username: "inventory@example.invalid", displayName: "Inventory", roles: ["AgentControl.Admin"] },
    }, error => error ? reject(error) : resolve()));
    cookie = `agent-control.sid=${encodeURIComponent(`s:${id}.${signature}`)}`;
    server = await new Promise<Server>(resolve => {
      const value = application.app.listen(0, "127.0.0.1", () => resolve(value));
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  }, 30_000);
  afterAll(async () => {
    vi.restoreAllMocks();
    application?.store.close();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    await fixture?.close();
  });
  it("distinguishes first-login availability from an empty published inventory and real invalidation", async () => {
    const freshPrincipal = randomUUID(), sessionId = randomUUID();
    const signature = createHmac("sha256", config.sessionSecret).update(sessionId).digest("base64").replace(/=+$/g, "");
    await new Promise<void>((resolve, reject) => application.store.set(sessionId, {
      cookie: new session.Cookie({ maxAge: 600_000 }),
      tenantId: config.tenants[0].tenantId, accountId: freshPrincipal, clientId: config.tenants[0].clientId,
      rolesValidatedAt: Date.now(), csrfToken: "fresh-inventory-csrf",
      user: { tenantId: config.tenants[0].tenantId, homeAccountId: freshPrincipal,
        username: "fresh@example.invalid", displayName: "Fresh viewer", roles: ["AgentControl.Viewer"] },
    }, error => error ? reject(error) : resolve()));
    const headers = { cookie: `agent-control.sid=${encodeURIComponent(`s:${sessionId}.${signature}`)}`,
      Origin: config.frontendOrigin, "Content-Type": "application/json", "X-CSRF-Token": "fresh-inventory-csrf" };
    const capture = () => fetch(`${base}/agent-inventory/selections`, { method: "POST", headers, body: JSON.stringify({ query: {} }) });
    async function expectUnavailable(state: string) {
      const guard = forbidAuthorityWrites(fixture.runtime);
      try {
        const response = await capture();
        expect(response.status, await response.clone().text()).toBe(200);
        expect(await response.json()).toEqual({ state, message: expect.any(String) });
        expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM data_read_selections WHERE principal_id=$1", [freshPrincipal])).rows[0].count).toBe(0);
      } finally { guard.restore(); }
    }
    await expectUnavailable("not_collected");
    const input = inventoryInput(freshPrincipal);
    input.scope.tenantId = config.tenants[0].tenantId;
    const source = await new InventoryGenerations(fixture.runtime).execute(input,
      { domain: "packages", mode: "baseline", channel: "catalog" }, async lease => {
        const store = new InventoryGenerations(fixture.runtime);
        await store.visit(lease, "empty");
        await store.acceptPage(lease, { token: "empty", nextToken: null, records: [], rawCount: 0, expectedCount: 0, page: 1 }, 0);
      }, { authorize: async () => {} });
    const canonical = inventoryInput(freshPrincipal, "canonical");
    canonical.scope.tenantId = input.scope.tenantId;
    const reconciliation = new InventoryReconciliation(fixture.runtime);
    await reconciliation.request(canonical, [source]);
    await expectUnavailable("preparing");
    await reconciliation.runNext(canonical, async () => {});
    const published = await capture();
    expect(published.status, await published.clone().text()).toBe(201);
    const selected = await published.json();
    const page = await fetch(`${base}/agent-inventory?selectionId=${selected.id}`, { headers });
    expect(page.status, await page.clone().text()).toBe(200);
    expect(await page.json()).toMatchObject({ value: [], counts: { total: 0, filtered: 0 },
      sources: { graphPackages: { state: "available" } } });
    await fixture.operator.query("UPDATE data_read_selections SET invalidated_at=clock_timestamp() WHERE id=$1", [selected.id]);
    const invalidated = await fetch(`${base}/agent-inventory?selectionId=${selected.id}`, { headers });
    expect(invalidated.status).toBe(409);
    expect(await invalidated.json()).toMatchObject({ code: "selection_invalidated" });
  });
  it("serves an exact counted page without source-wide reads or GET reconciliation", async () => {
    for (const module of ["packageInventory", "powerPlatformInventory", "unifiedAgentRegistry", "unifiedInventoryRevision"]) {
      expect(existsSync(new URL(`../db/${module}.ts`, import.meta.url)), `${module} must be deleted, not retained as a fallback`).toBe(false);
    }
    const guard = forbidAuthorityWrites(fixture.runtime);
    const response = await fetch(`${base}/agent-inventory?limit=50`, { headers: { cookie } });
    expect(response.status, await response.clone().text()).toBe(200);
    const result = await response.json();
    expect(result.value).toHaveLength(50);
    expect(result.counts).toMatchObject({ total: 101, filtered: 101 });
    expect(result.page.nextCursor).toEqual(expect.any(String));
    expect(result.selection.id).toEqual(expect.any(String));
    expect(result.selection.evaluatedAt).toEqual(expect.any(String));
    expect(result.inventoryOverview).toMatchObject({ availableToUsers: expect.any(Number) });
    for (const retired of ["count", "offset", "limit", "revision", "expiresAt", "facets"]) expect(result).not.toHaveProperty(retired);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1_048_576);
    expect(guard.count()).toBeGreaterThan(0);
    guard.restore();
  });
  it.each(["agent-inventory", "agents"])("captures wide %s criteria as metadata and reads their exact frozen scope through a bounded URL", async resource => {
    const body = JSON.stringify({ query: { publisher: `~string:${widePublisher}`, inventoryScope: "catalog", sortBy: "publisher" },
      ...(resource === "agents" ? { mode: "delegated" } : {}) });
    expect((await fetch(`${base}/${resource}/selections`, {
      method: "POST", headers: { cookie, Origin: config.frontendOrigin, "Content-Type": "application/json" }, body,
    })).status).toBe(403);
    const guard = forbidAuthorityWrites(fixture.runtime);
    try {
      const captured = await fetch(`${base}/${resource}/selections`, {
        method: "POST", headers: { cookie, Origin: config.frontendOrigin, "Content-Type": "application/json", "X-CSRF-Token": "inventory-csrf" }, body,
      });
      expect(captured.status, await captured.clone().text()).toBe(201);
      const selection = await captured.json();
      expect(selection).toMatchObject({ id: expect.any(String), queryHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(selection).not.toHaveProperty("value");
      const response = await fetch(`${base}/${resource}?selectionId=${selection.id}&limit=50`, { headers: { cookie } });
      expect(response.status, await response.clone().text()).toBe(200);
      const page = await response.json();
      expect(page).toMatchObject({ ...(resource === "agent-inventory" ? { inventoryScope: "catalog" } : {}),
        counts: { total: 101, scoped: 101, filtered: 1 } });
      expect(page.value).toHaveLength(1);
      expect(resource === "agent-inventory" ? page.value[0].packages[0] : page.value[0])
        .toMatchObject({ id: "package-000001", publisher: widePublisher });
      if (resource === "agents") {
        expect((await fetch(`${base}/agent-inventory?selectionId=${selection.id}`, { headers: { cookie } })).status).toBe(400);
      }
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(1_048_576);
      expect(guard.count()).toBeGreaterThan(0);
    } finally { guard.restore(); }
  });
  it("reads selected saved package details without embedding high-fanout collections or using legacy readers", async () => {
    const guard = forbidAuthorityWrites(fixture.runtime);
    const selected = await fetch(`${base}/agent-inventory?limit=50`, { headers: { cookie } });
    expect(selected.status, await selected.clone().text()).toBe(200);
    const page = await selected.json();
    const read = await fetch(`${base}/agents/package-000000/detail?selectionId=${page.selection.id}`, { headers: { cookie } });
    expect(read.status, await read.clone().text()).toBe(200);
    const detail = await read.json();
    expect(detail).toMatchObject({ id: "package-000000", displayName: "Agent 0", isBlocked: false,
      observation: { current: true }, allowedUsersAndGroups: [
        { resourceId: "33333333-3333-4333-8333-333333333333", resourceType: "group" },
      ], acquireUsersAndGroups: [] });
    expect(detail.elementDetails).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(detail))).toBeLessThanOrEqual(524288);
    const { recordId, sourceScopeId, sourceIdentity } = detail.selectedSource;
    const children = await fetch(`${base}/agent-inventory/${recordId}/children?${new URLSearchParams({
      selectionId: page.selection.id, sourceScopeId, sourceIdentity, kind: "element", limit: "50",
    })}`, { headers: { cookie } }).then(response => response.json());
    expect(children.total).toBe(101);
    expect(children.value).toHaveLength(50);
    expect(children.nextCursor).toEqual(expect.any(String));
    const exact = await fetch(`${base}/agents?limit=1&recordId=graph_packages%3Apackage-000000`, { headers: { cookie } }).then(response => response.json());
    expect(exact.value).toHaveLength(1);
    const source = await fetch(`${base}/agents/package-000000/detail?selectionId=${exact.selection.id}`, { headers: { cookie } });
    expect(source.status, await source.clone().text()).toBe(200);
    const sourceDetail = await source.json();
    expect(sourceDetail.id).toBe("package-000000");
    const childrenQuery = new URLSearchParams({ selectionId: page.selection.id, sourceScopeId,
      sourceIdentity, kind: "element", limit: "50", cursor: children.nextCursor });
    const next = await fetch(`${base}/agent-inventory/${recordId}/children?${childrenQuery}`,
      { headers: { cookie } }).then(response => response.json());
    expect(next.value).toHaveLength(50);
    expect(next.value[0].ordinal).toBeGreaterThan(children.value.at(-1).ordinal);
    expect((await fetch(`${base}/agents/package-000000/detail`, { headers: { cookie } })).status).toBe(400);
    expect((await fetch(`${base}/agents/package-000000`, { headers: { cookie } })).status).toBe(404);
    expect((await fetch(`${base}/agents/package-000000/collections/element`, { headers: { cookie } })).status).toBe(404);
    expect((await fetch(`${base}/agents/snapshots`, { headers: { cookie } })).status).toBe(404);
    expect(guard.count()).toBeGreaterThan(0);
    guard.restore();
  });
  it("stages server-filtered current package mutations through the actual HTTP route without whole-target reads", async () => {
    const page = await fetch(`${base}/agent-inventory?limit=50`, { headers: { cookie } }).then(response => response.json());
    expect(page.counts.packageTargets).toBe(101);
    const headers = { cookie, Origin: config.frontendOrigin, "X-CSRF-Token": "inventory-csrf", "Content-Type": "application/json" };
    const counted = await fetch(`${base}/agents/mutation-selection`, { method: "POST", headers,
      body: JSON.stringify({ selectionId: page.selection.id, ids: [page.value[0].packages[0].id], recordIds: [page.value[0].id] }) });
    expect(counted.status, await counted.clone().text()).toBe(200);
    expect(await counted.json()).toEqual({ count: 1 });
    expect((await fixture.runtime.query("SELECT count(*)::int AS total FROM inventory_mutation_stages WHERE principal_id=$1",
      [principalId])).rows[0].total).toBe(0);
    const response = await fetch(`${base}/agents/mutation-preview`, { method: "POST", headers,
      body: JSON.stringify({ action: "block", mutationScope: "bulk", selectionId: page.selection.id }) });
    expect(response.status, await response.clone().text()).toBe(200);
    const preview = await response.json();
    expect(preview.summary).toMatchObject({ targetCount: 101, additionalTargetCount: 81 });
    expect(preview.summary.targets).toHaveLength(20);
    expect(preview.selectionId).toBe(page.selection.id);
    expect((await fixture.runtime.query("SELECT count(*)::int AS total FROM inventory_mutation_targets WHERE stage_id=$1", [preview.stageId])).rows[0].total).toBe(101);
    expect((await fetch(`${base}/agents/mutation-preview`, { method: "POST", headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "block", mutationScope: "bulk", selectionId: page.selection.id }) })).status).toBe(403);
  });
  it("stages selected refresh targets transactionally without downloading or publishing inventory", async () => {
    const page = await fetch(`${base}/agent-inventory?limit=50`, { headers: { cookie } }).then(response => response.json());
    const headers = { cookie, Origin: config.frontendOrigin, "X-CSRF-Token": "inventory-csrf",
      "Content-Type": "application/json", "Idempotency-Key": "selected-refresh" };
    const generations = (await fixture.runtime.query("SELECT count(*)::int AS total FROM data_generations")).rows[0].total;
    const post = (body: object, key = "selected-refresh") => fetch(`${base}/agents/refresh-selection`,
      { method: "POST", headers: { ...headers, "Idempotency-Key": key }, body: JSON.stringify(body) });
    const response = await post({ selectionId: page.selection.id });
    expect(response.status, await response.clone().text()).toBe(202);
    const job = await response.json();
    expect(job).toMatchObject({ status: "waiting_authorization", tokenMode: "delegated", targetCount: 101 });
    expect(job.requestedIds).toBeUndefined();
    expect(job.detailTargets).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(job))).toBeLessThan(4096);
    const retry = await post({ selectionId: page.selection.id });
    expect(retry.status, await retry.clone().text()).toBe(202);
    expect((await retry.json()).id).toBe(job.id);
    expect((await post({ selectionId: page.selection.id, ids: ["package-000000"] })).status).toBe(409);
    const group = page.value.find((row: { packages: { id: string }[] }) => row.packages.some(item => item.id === "package-000000"));
    const one = await post({ selectionId: page.selection.id, ids: ["package-000000"], recordIds: [group.id] }, "selected-overlap");
    expect(one.status, await one.clone().text()).toBe(202);
    expect((await one.json()).targetCount).toBe(1);
    expect((await fixture.runtime.query("SELECT count(*)::int AS total FROM data_generations")).rows[0].total).toBe(generations);
    const targets = await fetch(`${base}/agents/refresh-jobs/${job.id}/targets?mode=delegated&limit=50`, { headers: { cookie } });
    expect(targets.status, await targets.clone().text()).toBe(200);
    const items = await targets.json();
    expect(items.value).toHaveLength(50);
    expect(items.counts.total).toBe(101);
    expect(items.page.nextCursor).toEqual(expect.any(String));
  });
  it("binds package pages to their source and narrowly authorized application owner without replacing the reader", async () => {
    const delegated = await fetch(`${base}/agents?limit=50`, { headers: { cookie } }).then(response => response.json());
    expect(delegated.value).toHaveLength(50);
    expect(delegated.counts).toMatchObject({ total: 101, filtered: 101 });
    expect((await fetch(`${base}/agent-inventory?selectionId=${delegated.selection.id}`, { headers: { cookie } })).status).toBe(400);
    const input = inventoryInput(config.tenants[0].clientId);
    await fixture.runtime.query(`INSERT INTO capability_configuration(tenant_id,capability_id,enabled,shared_data_scope,updated_by)
      VALUES($1,'graph.package.read.application',true,true,$2) ON CONFLICT(tenant_id,capability_id)
      DO UPDATE SET enabled=true,shared_data_scope=true`, [config.tenants[0].tenantId, principalId]);
    input.scope.tenantId = config.tenants[0].tenantId;
    input.scope.tokenMode = "application";
    const stages = new InventoryGenerations(fixture.runtime);
    const root = await stages.execute(input, { domain: "packages", mode: "baseline", channel: "catalog" }, async lease => {
      const records = [packageRecord(0, "Application-owned package")];
      await stages.visit(lease, "application");
      await stages.appendBounded(lease, records);
      await stages.acceptPage(lease, { token: "application", nextToken: null, records, rawCount: 1, expectedCount: 1, page: 1 }, 1);
    }, { authorize: async () => {} });
    const identity = await reportIdentity(fixture.runtime, { tenantId: config.tenants[0].tenantId, homeAccountId: principalId,
      displayName: "Reader", username: "reader@example.invalid", roles: ["AgentControl.Admin"] });
    const ordinary = new InventoryQueries(fixture.runtime, config.sessionSecret);
    await expect(ordinary.capture(identity, root.scopeId, {}, "application")).rejects.toMatchObject({ code: "selection_invalidated" });
    const authorize = vi.spyOn(capabilities, "requireApplicationDataScope").mockResolvedValue({
      enabled: true, sharedDataScope: true, previewQualified: false, revision: 1,
    });
    try {
      const capture = () => fetch(`${base}/agents/selections`, { method: "POST", headers: {
        cookie, Origin: config.frontendOrigin, "X-CSRF-Token": "inventory-csrf", "Content-Type": "application/json",
      }, body: JSON.stringify({ mode: "application", query: {} }) });
      const captured = await capture();
      expect(captured.status, await captured.clone().text()).toBe(201);
      const applicationSelection = await captured.json();
      const response = await fetch(`${base}/agents?mode=application&selectionId=${applicationSelection.id}`, { headers: { cookie } });
      expect(response.status, await response.clone().text()).toBe(200);
      const applicationPage = await response.json();
      expect(applicationPage.value).toHaveLength(1);
      expect(applicationPage.value[0].displayName).toBe("Application-owned package");
      expect(authorize).toHaveBeenCalledWith("graph.package.read.application", expect.objectContaining({ homeAccountId: principalId }));
      const saved = (await fixture.runtime.query("SELECT principal_id FROM data_read_selections WHERE id=$1", [applicationPage.selection.id])).rows[0];
      expect(saved.principal_id).toBe(principalId);
      await expect(ordinary.page(applicationPage.selection.id, identity)).rejects.toMatchObject({ code: "selection_invalidated" });
      const approved = new InventoryQueries(fixture.runtime, config.sessionSecret, 7,
        { tenantId: identity.tenantId, principalId: config.tenants[0].clientId });
      await expect(approved.page(applicationPage.selection.id, { ...identity, authorizationHash: "changed-role" })).rejects.toMatchObject({ code: "selection_invalidated" });
      const admitted = await fetch(`${base}/data-exports`, { method: "POST", headers: {
        cookie, Origin: config.frontendOrigin, "X-CSRF-Token": "inventory-csrf", "Content-Type": "application/json",
      }, body: JSON.stringify({ kind: "graph_packages", selectionId: applicationPage.selection.id }) });
      expect(admitted.status, await admitted.clone().text()).toBe(202);
      const exported = await admitted.json();
      await expect.poll(async () => (await fetch(`${base}/data-exports/${exported.id}`, { headers: { cookie } }).then(value => value.json())).status).toBe("ready");
      expect(await fetch(`${base}/data-exports/${exported.id}/download`, { headers: { cookie } }).then(value => value.text())).toContain("Application-owned package");
      expect((await fetch(`${base}/agents?selectionId=${applicationPage.selection.id}`, { headers: { cookie } })).status).toBe(409);
      await fixture.runtime.query("UPDATE capability_configuration SET enabled=false WHERE tenant_id=$1 AND capability_id='graph.package.read.application'", [identity.tenantId]);
      await fixture.runtime.query("UPDATE capability_configuration SET enabled=true WHERE tenant_id=$1 AND capability_id='graph.package.read.application'", [identity.tenantId]);
      await expect(approved.page(applicationPage.selection.id, identity)).rejects.toMatchObject({ code: "selection_invalidated" });
      expect((await fetch(`${base}/data-exports/${exported.id}/download`, { headers: { cookie } })).status).toBe(409);
      authorize.mockRejectedValueOnce(new AppError(403, "not_configured", "Application authorization denied."));
      expect((await fetch(`${base}/agents?mode=application&selectionId=${applicationPage.selection.id}`, { headers: { cookie } })).status).toBe(403);
      authorize.mockRejectedValueOnce(new AppError(403, "not_configured", "Application authorization denied."));
      expect((await capture()).status).toBe(403);
    } finally { authorize.mockRestore(); }
  });
  it("reads exact canonical and source references, discovers counted sections, and pages children on one selection", async () => {
    const page = await fetch(`${base}/agent-inventory?limit=50`, { headers: { cookie } }).then(value => value.json());
    const first = page.value.find((row: { displayName: string }) => row.displayName === "Agent 0");
    const selection = new URLSearchParams({ selectionId: page.selection.id });
    const detail = await fetch(`${base}/agent-inventory/${encodeURIComponent(first.id)}/detail?${selection}`, { headers: { cookie } });
    expect(detail.status, await detail.clone().text()).toBe(200);
    expect((await detail.json()).id).toBe(first.id);
    const source = await fetch(`${base}/agent-inventory/graph_packages%3Apackage-000000/detail?${selection}`, { headers: { cookie } });
    expect(source.status).toBe(200);
    expect((await source.json()).id).toBe(first.id);
    const members = await fetch(`${base}/agent-inventory/${encodeURIComponent(first.id)}/members?${selection}`, { headers: { cookie } }).then(value => value.json());
    expect(members.total).toBe(1);
    selection.set("sourceScopeId", members.value[0].source_scope_id);
    selection.set("sourceIdentity", members.value[0].source_identity);
    const sections = await fetch(`${base}/agent-inventory/${encodeURIComponent(first.id)}/sections?${selection}`, { headers: { cookie } });
    expect(sections.status, await sections.clone().text()).toBe(200);
    expect((await sections.json()).value).toContainEqual({ kind: "element", total: 101 });
    selection.set("kind", "element");
    selection.set("limit", "50");
    const children = await fetch(`${base}/agent-inventory/${encodeURIComponent(first.id)}/children?${selection}`, { headers: { cookie } });
    expect(children.status, await children.clone().text()).toBe(200);
    const childPage = await children.json();
    expect(childPage.total).toBe(101);
    expect(childPage.value).toHaveLength(50);
    expect(childPage.nextCursor).toEqual(expect.any(String));
    expect((await fetch(`${base}/agent-inventory?selectionId=${page.selection.id}&source=power_platform`, { headers: { cookie } })).status).toBe(400);
    for (const suffix of ["limit=1e1", "limit=01", "search=a&search=b", "unknown=1"]) {
      expect((await fetch(`${base}/agent-inventory?${suffix}`, { headers: { cookie } })).status).toBe(400);
    }
  });
  it("builds audited inventory chunks with high-fanout children and serves a native authenticated download", async () => {
    const page = await fetch(`${base}/agent-inventory?limit=50`, { headers: { cookie } }).then(value => value.json());
    const actor = { tenantId: config.tenants[0].tenantId, homeAccountId: principalId,
      username: "inventory@example.invalid", displayName: "Inventory", roles: ["AgentControl.Admin"] };
    const who = await reportIdentity(fixture.runtime, actor);
    const exports = new OfficialReportExports(new LargeTenantUsersReports(fixture.runtime, config.sessionSecret, 7), actor);
    for (const kind of ["unified_agents", "graph_packages"] as const) {
      const id = await exports.create(who, { selectionId: page.selection.id, kind });
      await exports.build(id, who, kind);
      const status = await fetch(`${base}/data-exports/${id}`, { headers: { cookie } });
      expect(status.status, await status.clone().text()).toBe(200);
      expect(await status.json()).toMatchObject({ status: "ready", rows: expect.any(Number) });
      const response = await fetch(`${base}/data-exports/${id}/download`, { headers: { cookie } });
      expect(response.status, await response.clone().text()).toBe(200);
      expect(response.headers.get("Content-Disposition")).toContain("attachment;");
      const csv = await response.text();
      expect(csv).toContain("childKind");
      expect(csv).toContain("child-1-50");
      expect(csv).toContain("package-000100");
      await expect.poll(async () => (await fixture.runtime.query("SELECT count(*)::int AS count FROM audit_events WHERE operation_id=$1 AND status='succeeded'",
        [`data-export:${id}`])).rows[0].count).toBe(2);
    }
  });
  it("resolves explicit off-filter source references once and rejects unavailable references without a fallback export", async () => {
    const page = await fetch(`${base}/agent-inventory?search=Agent%200`, { headers: { cookie } }).then(value => value.json());
    expect(page.counts.filtered).toBe(1);
    const detail = await fetch(`${base}/agent-inventory/graph_packages:package-000100/detail?selectionId=${page.selection.id}`,
      { headers: { cookie } }).then(value => value.json());
    const headers = { cookie, Origin: config.frontendOrigin, "X-CSRF-Token": "inventory-csrf", "Content-Type": "application/json" };
    const response = await fetch(`${base}/data-exports`, { method: "POST", headers, body: JSON.stringify({
      kind: "unified_agents", selectionId: page.selection.id, ids: ["graph_packages:package-000100", detail.id],
    }) });
    expect(response.status, await response.clone().text()).toBe(202);
    const { id } = await response.json();
    await expect.poll(async () => (await fetch(`${base}/data-exports/${id}`, { headers: { cookie } }).then(value => value.json())).status).toBe("ready");
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM data_export_items WHERE export_id=$1", [id])).rows[0].count).toBe(1);
    const csv = await fetch(`${base}/data-exports/${id}/download`, { headers: { cookie } }).then(value => value.text());
    const rows = parseCsv(csv, { bom: true, columns: true }) as Array<Record<string, string>>;
    expect(rows.filter(row => row.recordType === "agent").map(row => row.displayName)).toEqual(["Agent 100"]);
    for (const input of [
      { kind: "unified_agents", ids: ["graph_packages:missing"] },
      { kind: "power_platform_agents" },
    ]) {
      const rejected = await fetch(`${base}/data-exports`, { method: "POST", headers, body: JSON.stringify({ selectionId: page.selection.id, ...input }) });
      expect(rejected.status, await rejected.clone().text()).toBe(409);
    }
  });
  it("keeps the first selection through refresh, pages backwards and rejects another principal's cursor", async () => {
    const first = await fetch(`${base}/agent-inventory?limit=50`, { headers: { cookie } }).then(response => response.json());
    const usagePath = `${base}/agent-inventory/${encodeURIComponent(first.value[0].id)}/usage`;
    const usageResponse = await fetch(usagePath, { headers: { cookie } });
    expect(usageResponse.status, await usageResponse.clone().text()).toBe(200);
    const initialUsage = await usageResponse.json();
    expect(initialUsage.status).toBe("unavailable");
    const sourceInput = inventoryInput(principalId);
    sourceInput.scope.tenantId = config.tenants[0].tenantId;
    const stages = new InventoryGenerations(fixture.runtime);
    const source = await stages.execute(sourceInput, { domain: "packages", mode: "baseline", channel: "catalog" }, async lease => {
      const records = Array.from({ length: 102 }, (_, index) => packageRecord(index, `Refreshed ${index}`));
      await stages.visit(lease, "new");
      await stages.appendBounded(lease, records);
      await stages.acceptPage(lease, { token: "new", nextToken: null, records, rawCount: 102, expectedCount: 102, page: 1 }, 102);
    }, { authorize: async () => {} });
    expect((await fetch(usagePath, { headers: { cookie } })).status).toBe(404);
    const input = inventoryInput(principalId, "canonical");
    input.scope.tenantId = config.tenants[0].tenantId;
    const reconciliation = new InventoryReconciliation(fixture.runtime);
    await reconciliation.request(input, [source]);
    await reconciliation.runNext(input, async () => {});
    const currentUsage = await fetch(usagePath, { headers: { cookie } }).then(response => response.json());
    expect(currentUsage.status).toBe("unavailable");
    expect(currentUsage.context.inventoryRevision).not.toBe(initialUsage.context.inventoryRevision);
    const selected = new URLSearchParams({ selectionId: first.selection.id, limit: "50", cursor: first.page.nextCursor });
    const middleResponse = await fetch(`${base}/agent-inventory?${selected}`, { headers: { cookie } });
    expect(middleResponse.status).toBe(200);
    const middle = await middleResponse.json();
    expect(middle.counts.total).toBe(101);
    expect(middle.value).toHaveLength(50);
    expect(middle.value.every((row: { displayName: string }) => row.displayName.startsWith("Agent "))).toBe(true);
    selected.set("cursor", middle.page.nextCursor);
    const last = await fetch(`${base}/agent-inventory?${selected}`, { headers: { cookie } }).then(response => response.json());
    expect(last.value).toHaveLength(1);
    expect(last.page.nextCursor).toBeNull();
    selected.set("cursor", middle.page.previousCursor);
    const back = await fetch(`${base}/agent-inventory?${selected}`, { headers: { cookie } }).then(response => response.json());
    const historical = structuredClone(first.value);
    for (const row of historical) {
      expect(row.observations.graphPackages.current).toBe(true);
      row.observations.graphPackages.current = false;
      for (const observation of Object.values(row.observations.packageSnapshots) as Array<{ current: boolean }>) {
        expect(observation.current).toBe(true);
        observation.current = false;
      }
    }
    expect(back.value).toEqual(historical);
    expect(back.selection).toEqual(first.selection);
    const fresh = await fetch(`${base}/agent-inventory?limit=50`, { headers: { cookie } }).then(response => response.json());
    expect(fresh.counts.total).toBe(102);
    selected.set("selectionId", fresh.selection.id);
    expect((await fetch(`${base}/agent-inventory?${selected}`, { headers: { cookie } })).status).toBe(400);
    expect((await fetch(`${base}/agent-inventory?offset=50`, { headers: { cookie } })).status).toBe(400);
  });
  it("commits the real source head and refresh job together and recovers canonical work off GET", async () => {
    const scope = { tenantId: config.tenants[0].tenantId, principalId };
    const jobs = new PackageRefreshJobs(fixture.runtime);
    const job = await jobs.submit(scope, { tokenMode: "delegated", authorizationPrincipalId: principalId,
      idempotencyKey: randomUUID() });
    await jobs.markRunning(scope, job.id);
    const input = await inventoryJobInput(fixture.runtime, scope, "packages", job.id);
    const graph = new GraphPackagesClient(async () => new Response(JSON.stringify({
      value: [{ id: "real-provider-row", displayName: "Streamed provider row", isBlocked: false }], "@odata.count": 1,
    }), { headers: { "Content-Type": "application/json" } }));
    const stream = new StreamedInventory(fixture.runtime, graph);
    await stream.graphCatalog(input, "synthetic-token", { authorize: async () => {}, completeJob: completeInventoryJob(input, "packages") });
    expect((await jobs.getJob(scope, job.id))?.status).toBe("succeeded");
    const before = await fetch(`${base}/agent-inventory?limit=50`, { headers: { cookie } }).then(response => response.json());
    expect(before.counts.total).toBe(102);
    const runtime = new InventoryRuntime(fixture.runtime, async () => {});
    await runtime.pass();
    await runtime.drain();
    const after = await fetch(`${base}/agent-inventory?limit=50`, { headers: { cookie } }).then(response => response.json());
    expect(after.counts.total).toBe(1);
    expect(after.value[0].displayName).toBe("Streamed provider row");
  });

  it("stages 5000 refresh targets without metadata arrays and serves current revision-bound HTTP pages", async () => {
    const scope = { tenantId: config.tenants[0].tenantId, principalId }, jobs = new PackageRefreshJobs(fixture.runtime);
    const requestedIds = Array.from({ length: 5000 }, (_, index) => `opaque-Target-${String(index).padStart(4, "0")}`);
    const job = await jobs.submit(scope, { tokenMode: "delegated", authorizationPrincipalId: principalId, requestedIds, idempotencyKey: randomUUID() });
    expect(job.targetCount).toBe(5000);
    expect(job).not.toHaveProperty("requestedIds");
    expect(Buffer.byteLength(JSON.stringify(job))).toBeLessThan(16384);
    const response = await fetch(`${base}/agents/refresh-jobs/${job.id}/targets?limit=100&revision=${encodeURIComponent(job.resultRevision)}`, { headers: { cookie } });
    expect(response.status, await response.clone().text()).toBe(200);
    const first = await response.json();
    expect(first.value).toHaveLength(100);
    expect(first.counts).toEqual({ total: 5000, filtered: 5000 });
    expect(first.value[0].id).toBe(requestedIds[0]);
    const query = new URLSearchParams({ limit: "100", revision: first.revision, cursor: first.page.nextCursor });
    const second = await fetch(`${base}/agents/refresh-jobs/${job.id}/targets?${query}`, { headers: { cookie } }).then(value => value.json());
    expect(second.value[0].id).toBe(requestedIds[100]);
    query.set("cursor", second.page.previousCursor);
    const previous = await fetch(`${base}/agents/refresh-jobs/${job.id}/targets?${query}`, { headers: { cookie } }).then(value => value.json());
    expect(previous.value).toEqual(first.value);
    await jobs.markRunning(scope, job.id);
    expect((await fetch(`${base}/agents/refresh-jobs/${job.id}/targets?${query}`, { headers: { cookie } })).status).toBe(409);
    await expect(jobs.submit(scope, { tokenMode: "delegated", authorizationPrincipalId: principalId,
      requestedIds: [...requestedIds, "over-limit"], idempotencyKey: randomUUID() })).rejects.toMatchObject({ status: 400 });
  });

  it("streams more than twenty exact targets through one fenced generation and commits only the complete job", async () => {
    const scope = { tenantId: config.tenants[0].tenantId, principalId }, jobs = new PackageRefreshJobs(fixture.runtime);
    const ids = Array.from({ length: 21 }, (_, index) => `Exact-${index}`);
    const job = await jobs.submit(scope, { tokenMode: "delegated", authorizationPrincipalId: principalId,
      requestedIds: ids, idempotencyKey: randomUUID() });
    await jobs.markRunning(scope, job.id);
    const input = await inventoryJobInput(fixture.runtime, scope, "packages", job.id);
    let requests = 0;
    const graph = new GraphPackagesClient(async url => {
      requests++;
      const id = decodeURIComponent(String(url).split("/packages/")[1]?.split("?")[0] ?? "");
      return new Response(JSON.stringify({ id, displayName: id, isBlocked: false }), { headers: { "Content-Type": "application/json" } });
    });
    await new StreamedInventory(fixture.runtime, graph).exactJob(input, "synthetic-token", false,
      { authorize: async () => {}, completeJob: completeInventoryJob(input, "packages") });
    expect(requests).toBe(21);
    expect((await jobs.getJob(scope, job.id))?.status).toBe("succeeded");
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM inventory_keys WHERE generation_id=(SELECT id FROM data_generations WHERE job_id=$1)", [job.id])).rows[0].count).toBe(21);
  });

  it("selects counted responsibility and exact people evidence in SQL with independently pinned agent pages", async () => {
    const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const c = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", d = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const type = "microsoft.copilotstudio/agents";
    const input = inventoryInput(principalId, "power_platform");
    input.scope.tenantId = config.tenants[0].tenantId;
    const intent = { domain: "power_platform" as const, mode: "baseline" as const, channel: "catalog" as const,
      resourceTypes: [type, "microsoft.powerplatform/environments"], roleScope: "full" as const };
    input.scope.selector = inventorySelector(intent);
    const stages = new InventoryGenerations(fixture.runtime);
    await stages.execute(input, intent, async lease => {
      const records = [
        { name: "Shared", owner: a, creator: a, modifier: b },
        { name: "Shared", owner: a, creator: a, modifier: "invalid-reference" },
        { name: "Zülü", owner: b, creator: c, modifier: null },
        { name: "Tail", owner: a, creator: c, modifier: b },
      ].map((value, index) => powerPlatformInventoryRecord({
        sourceSystem: "power_platform", nativeId: `responsibility-${index}`, type, environmentId: "owner-environment",
        tenantId: input.scope.tenantId, displayName: value.name, location: null, createdAt: null, createdBy: value.creator,
        creatorType: "user", agentKind: index === 3 ? "copilot_studio_agent" : "agent", lifecycle: "published", lastPublishedAt: null, authoringTool: null,
        identityConfidence: "exact_native", identifiers: index === 3 ? [{ kind: "entra_agent_id", value: c }] : [],
        provenance: index === 3 ? { entraAgentId: { sourceSystem: "power_platform", path: "properties.entraAgentId", maturity: "ga" } } : {},
        unknownFieldCount: 0,
        details: { ownerId: value.owner, lastModifiedBy: value.modifier },
      } satisfies PowerPlatformResource));
      records.push(powerPlatformInventoryRecord({
        sourceSystem: "power_platform", nativeId: "owner-environment", type: "microsoft.powerplatform/environments",
        environmentId: "owner-environment", tenantId: input.scope.tenantId, displayName: "Saved owner environment",
        location: "europe", createdAt: null, createdBy: null, creatorType: "unknown", agentKind: "environment",
        lifecycle: "unknown", lastPublishedAt: null, authoringTool: null, identityConfidence: "exact_native",
        identifiers: [], provenance: {}, unknownFieldCount: 0,
        details: { environmentType: "Production", isManaged: false, environmentGroup: "Saved group", environmentGroupId: "group-1" },
      }));
      await stages.visit(lease, "responsibility");
      await stages.appendBounded(lease, records);
      await stages.acceptPage(lease, { token: "responsibility", nextToken: null, records, rawCount: records.length, expectedCount: records.length, page: 1 }, records.length);
    }, { authorize: async () => {} });
    const runtime = new InventoryRuntime(fixture.runtime, async () => {});
    await runtime.pass();
    await runtime.drain();
    for (const [objectId, displayName] of [[a, "Same"], [b, "Same"], [c, "Zülü＃"], [d, "Zero responsibility"]]) {
      await fixture.runtime.query(`INSERT INTO agent_people_cache(tenant_id,principal_id,object_id,revision,status,
        display_name,user_principal_name,checked_at,resolved_at,expires_at)
        VALUES($1,$2,$3,$4,'resolved',$5,NULL,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '10 minutes')`,
      [input.scope.tenantId, principalId, objectId, randomUUID(), displayName]);
    }
    const inventoryResponse = await fetch(`${base}/agent-inventory?source=power_platform&limit=50`, { headers: { cookie } });
    expect(inventoryResponse.status, await inventoryResponse.clone().text()).toBe(200);
    const inventoryPage = await inventoryResponse.json();
    expect(inventoryPage.value).toHaveLength(4);
    const tail = inventoryPage.value.find((row: { displayName: string }) => row.displayName === "Tail");
    expect(tail).toMatchObject({
      environment: { id: "owner-environment", displayName: "Saved owner environment", region: "europe",
        environmentType: "Production", isManaged: false, groupName: "Saved group", groupId: "group-1",
        observation: { current: true } },
      people: { owner: { objectId: a, displayName: "Same", status: "resolved" },
        createdBy: { objectId: c, displayName: "Zülü＃", status: "resolved" },
        lastModifiedBy: { objectId: b, displayName: "Same", status: "resolved" } },
      usage: { status: "unavailable", reportSetId: null, responses: null, activeUsers: null, associationCount: 0 },
    });
    expect(inventoryPage.usageContext.reports.setId).toBeNull();
    expect(Buffer.byteLength(JSON.stringify(inventoryPage))).toBeLessThanOrEqual(1_048_576);
    const selectedDetail = await fetch(`${base}/agent-inventory/${tail.id}/detail?selectionId=${inventoryPage.selection.id}`, { headers: { cookie } });
    expect(selectedDetail.status, await selectedDetail.clone().text()).toBe(200);
    expect(await selectedDetail.json()).toEqual(tail);
    const get = async (query: Record<string, string>) => {
      const response = await fetch(`${base}/agent-responsibility?${new URLSearchParams(query)}`, { headers: { cookie } });
      expect(response.status, await response.clone().text()).toBe(200);
      return response.json();
    };
    const first = await get({ limit: "1" });
    expect(first.counts).toEqual({ total: 3, filtered: 3 });
    expect(first.people).toEqual([{ objectId: a, agentCount: 3, roles: ["owner", "createdBy"],
      evidence: expect.objectContaining({ objectId: a, displayName: "Same", userPrincipalName: null, status: "resolved" }) }]);
    expect(first.coverage).toBe("partial");
    expect(first.invalidReferenceCount).toBe(1);
    expect(first.page.previousCursor).toBeNull();
    const second = await get({ selectionId: first.selection.id, limit: "1", cursor: first.page.nextCursor });
    expect(second.people[0]).toMatchObject({ objectId: b, agentCount: 3, roles: ["owner", "lastModifiedBy"] });
    const last = await get({ selectionId: first.selection.id, limit: "1", cursor: second.page.nextCursor });
    expect(last.people[0]).toMatchObject({ objectId: c, agentCount: 2, roles: ["createdBy"] });
    expect(last.page.nextCursor).toBeNull();
    const previous = await get({ selectionId: first.selection.id, limit: "1", cursor: last.page.previousCursor });
    expect(previous.people).toEqual(second.people);
    const search = await get({ search: "ZÜLÜ#", limit: "50" });
    expect(search.counts).toEqual({ total: 3, filtered: 1 });
    expect(search.people[0].objectId).toBe(c);
    const selected = await get({ objectId: a, limit: "1" });
    expect(selected.selected).toMatchObject({ count: 3, state: "reported",
      person: { objectId: a, agentCount: 3, roles: ["owner", "createdBy"] } });
    expect(selected.selected.agents).toHaveLength(1);
    expect(selected.selected.agents[0]).toMatchObject({ displayName: "Shared", roles: ["owner", "createdBy"],
      observedAt: input.observedAt.toISOString() });
    const nextAgent = await get({ objectId: a, selectionId: selected.selection.id, limit: "1", cursor: selected.page.nextCursor });
    expect(nextAgent.selected.agents[0].id).not.toBe(selected.selected.agents[0].id);
    const previousAgent = await get({ objectId: a, selectionId: selected.selection.id, limit: "1", cursor: nextAgent.page.previousCursor });
    expect(previousAgent.selected.agents).toEqual(selected.selected.agents);
    const empty = await get({ objectId: d });
    expect(empty.selected).toMatchObject({ state: "no_reported_relationships", count: 0, agents: [], person: { objectId: d, roles: [] } });
    expect((await fetch(`${base}/agent-responsibility?offset=1`, { headers: { cookie } })).status).toBe(400);
    expect((await fetch(`${base}/agent-responsibility?${new URLSearchParams({ selectionId: first.selection.id, cursor: first.page.nextCursor,
      objectId: a, limit: "1" })}`, { headers: { cookie } })).status).toBe(400);
    const all = await fetch(`${base}/agent-inventory?limit=1`, { headers: { cookie } }).then(response => response.json());
    expect(first.unknownAgentCount).toBe(all.counts.total - 2);
    const investigation = await fetch(`${base}/agent-inventory/investigations/context?${new URLSearchParams({
      recordId: unifiedAgentRecordId({ source: "power_platform", nativeId: "responsibility-3", environmentId: "owner-environment" }),
    })}`, { headers: { cookie } });
    expect(investigation.status, await investigation.clone().text()).toBe(200);
    expect(await investigation.json()).toMatchObject({ displayName: "Tail", defender: { status: "unavailable",
      resolution: { canResolve: true, cacheStatus: "missing", reasonCode: "identity_resolution_required" } } });
    const current = new LiveInventory(fixture.runtime), mappings = new AgentIdentityRepository(fixture.runtime);
    const resolver = new AgentInvestigationsService(current, current, mappings);
    const nativeId = unifiedAgentRecordId({ source: "power_platform", nativeId: "responsibility-3", environmentId: "owner-environment" });
    const scope = { tenantId: input.scope.tenantId, principalId };
    const context = await resolver.resolve(scope, nativeId);
    expect(context.identitySource).toBeDefined();
    await mappings.save(scope, context.identitySource!, { objectId: c, applicationId: c, runtimeStatus: "available",
      runtimeProvenance: verifiedAgentIdentityClientIdProvenance }, async () => {});
    expect((await resolver.resolve(scope, nativeId)).context.defender).toMatchObject({ status: "available",
      entraAgentIds: [c], entraAgentApplicationIds: [c],
      resolution: { cacheStatus: "resolved", runtimeProvenance: verifiedAgentIdentityClientIdProvenance } });
    await expect(mappings.save({ ...scope, principalId: "foreign-reader" }, context.identitySource!,
      { objectId: c, applicationId: c, runtimeStatus: "available", runtimeProvenance: verifiedAgentIdentityClientIdProvenance },
      async () => {})).rejects.toMatchObject({ code: "agent_identity_source_changed" });
  });
  it("fences unsafe control pins immediately and recovers changed-key readback without losing untouched membership", async () => {
    const scope = { tenantId: config.tenants[0].tenantId, principalId };
    const before = await fetch(`${base}/agent-inventory?limit=50`, { headers: { cookie } }).then(response => response.json());
    const saved = await fetch(`${base}/agents/Exact-0/detail?selectionId=${before.selection.id}`, { headers: { cookie } });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const original = await saved.json();
    await dataConnections(fixture.runtime).run(async client => {
      await publishPackageReadback(scope, { ...original, isBlocked: true }, client,
        await readPackageInventoryGeneration(scope, client), { kind: "block", isBlocked: true });
    });
    expect((await fetch(`${base}/agent-inventory?selectionId=${before.selection.id}`, { headers: { cookie } })).status).toBe(409);
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM inventory_control_pending WHERE tenant_id=$1 AND principal_id=$2",
      [scope.tenantId, principalId])).rows[0].count).toBe(1);
    const live = new LiveInventory(fixture.runtime);
    const reference = (packageId: string) => unifiedAgentRecordId({ source: "graph_packages", packageId });
    await expect(live.record(scope, reference("Exact-1"))).rejects.toMatchObject({ code: "agent_not_found" });
    const runtime = new InventoryRuntime(fixture.runtime, async () => {});
    expect(await runtime.publishControls(scope)).toBe(1);
    await runtime.enqueue(scope);
    const input = inventoryInput(principalId, "canonical"); input.scope.tenantId = scope.tenantId;
    const result = await runtime.reconciliation.runNext(input, async () => {});
    expect(result?.changed).toBe(1);
    await expect(live.record(scope, reference("Exact-1"))).resolves.toMatchObject({ displayName: "Exact-1" });
    const response = await fetch(`${base}/agent-inventory?limit=50`, { headers: { cookie } });
    expect(response.status, await response.clone().text()).toBe(200);
    const after = await response.json();
    expect(after.counts.total).toBe(before.counts.total);
    const changed = await fetch(`${base}/agent-inventory?recordId=${encodeURIComponent(reference("Exact-0"))}`, { headers: { cookie } }).then(value => value.json());
    expect(changed.value).toHaveLength(1);
    expect(changed.value[0].packages[0].isBlocked).toBe(true);
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM inventory_control_pending WHERE tenant_id=$1 AND principal_id=$2",
      [scope.tenantId, principalId])).rows[0].count).toBe(0);
    await dataConnections(fixture.runtime).run(async client => {
      await publishPackageReadback(scope, { ...original, id: "Not-in-the-catalog", isBlocked: true }, client,
        await readPackageInventoryGeneration(scope, client), { kind: "block", isBlocked: true });
    });
    expect(await runtime.publishControls(scope)).toBe(1);
    await runtime.enqueue(scope);
    await runtime.reconciliation.runNext({ ...input, jobId: randomUUID(), observedAt: new Date() }, async () => {});
    await expect(live.record(scope, reference("Not-in-the-catalog"))).rejects.toMatchObject({ code: "agent_not_found" });
    await expect(live.record(scope, reference("Exact-1"))).resolves.toMatchObject({ displayName: "Exact-1" });
    const final = await fetch(`${base}/agent-inventory?limit=50`, { headers: { cookie } }).then(value => value.json());
    expect(final.counts.total).toBe(before.counts.total);
  });
  it("streams 5001 real sources through canonical reconciliation, counted HTTP keysets and 5000 staged job targets", async () => {
    const started = performance.now(), owner = randomUUID(), total = 5001;
    const store = new InventoryGenerations(fixture.runtime), sourceInput = inventoryInput(owner);
    sourceInput.scope.tenantId = config.tenants[0].tenantId;
    sourceInput.reserveBytes = 64 * 1024 ** 2;
    const source = await store.execute(sourceInput, { domain: "packages", mode: "baseline", channel: "catalog" }, async lease => {
      for (let offset = 0, page = 1; offset < total; offset += 100, page++) {
        const records = Array.from({ length: Math.min(100, total - offset) }, (_, index) => {
          const ordinal = offset + index;
          return packageInventoryRecord({ id: `package-${String(ordinal).padStart(6, "0")}`,
            displayName: `Agent ${String(ordinal).padStart(6, "0")}`, isBlocked: ordinal === 5000 });
        });
        await store.visit(lease, String(offset));
        await store.appendBounded(lease, records);
        await store.acceptPage(lease, { token: String(offset), nextToken: offset + 100 < total ? String(offset + 100) : null,
          records, rawCount: records.length, expectedCount: total, page }, records.length);
      }
    }, { authorize: async () => {} });
    console.info("LARGE_INVENTORY_PHASE", "source", Math.round(performance.now() - started));
    const reconciler = new InventoryReconciliation(fixture.runtime), input = inventoryInput(owner, "canonical");
    input.scope.tenantId = sourceInput.scope.tenantId;
    input.reserveBytes = sourceInput.reserveBytes;
    await reconciler.request(input, [source]);
    const canonical = await reconciler.runNext(input, async () => {});
    console.info("LARGE_INVENTORY_PHASE", "canonical", Math.round(performance.now() - started));
    expect(canonical?.inserted).toBe(total);
    const originalQuery = pg.Client.prototype.query;
    let slowQueries = 0;
    const trace = vi.spyOn(pg.Client.prototype, "query").mockImplementation(function(this: pg.Client, ...args: Parameters<typeof originalQuery>) {
      const at = performance.now(), result = Reflect.apply(originalQuery, this, args);
      if (!result || typeof result.then !== "function") return result;
      return result.finally(() => {
        const elapsed = performance.now() - at;
        if (elapsed > 400 && slowQueries++ < 12) {
          const text = typeof args[0] === "string" ? args[0] : String((args[0] as { text?: string }).text);
          console.info("LARGE_INVENTORY_SQL", Math.round(elapsed), text.slice(-500));
        }
      });
    } as typeof originalQuery);
    const user = { tenantId: config.tenants[0].tenantId, homeAccountId: owner,
      username: "large-inventory@example.invalid", displayName: "Large inventory", roles: ["AgentControl.Admin" as const] };
    const sid = randomUUID(), signature = createHmac("sha256", config.sessionSecret).update(sid).digest("base64").replace(/=+$/g, "");
    await new Promise<void>((resolve, reject) => application.store.set(sid, {
      cookie: new session.Cookie({ maxAge: 600_000 }), user, tenantId: user.tenantId, accountId: owner,
      clientId: config.tenants[0].clientId, rolesValidatedAt: Date.now(), csrfToken: "large-inventory-csrf",
    }, error => error ? reject(error) : resolve()));
    const largeCookie = `agent-control.sid=${encodeURIComponent(`s:${sid}.${signature}`)}`;
    const read = async (path: string) => {
      const response = await fetch(`${base}${path}`, { headers: { cookie: largeCookie } });
      expect(response.status, await response.clone().text()).toBe(200);
      const value = await response.json();
      expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(1_048_576);
      return value;
    };
    const first = await read("/agent-inventory?limit=100");
    expect(first.counts).toMatchObject({ total, scoped: total, filtered: total, packageTargets: total });
    let page = first, seen = 0, pages = 0;
    for (;;) {
      expect(page.value.length).toBeLessThanOrEqual(100);
      for (const record of page.value) expect(record.packages[0].id).toBe(`package-${String(seen++).padStart(6, "0")}`);
      pages++;
      if (pages % 20 === 0) console.info("LARGE_INVENTORY_PHASE", `page-${pages}`, Math.round(performance.now() - started));
      if (!page.page.nextCursor) break;
      page = await read(`/agent-inventory?${new URLSearchParams({ selectionId: first.selection.id, limit: "100", cursor: page.page.nextCursor })}`);
    }
    expect(seen).toBe(total);
    expect(pages).toBe(51);
    console.info("LARGE_INVENTORY_PHASE", "pages", Math.round(performance.now() - started));
    const previous = await read(`/agent-inventory?${new URLSearchParams({ selectionId: first.selection.id, limit: "100", cursor: page.page.previousCursor })}`);
    expect(previous.value).toHaveLength(100);
    expect(previous.value[0].packages[0].id).toBe("package-004900");
    const headers = { cookie: largeCookie, Origin: config.frontendOrigin, "X-CSRF-Token": "large-inventory-csrf", "Content-Type": "application/json" };
    const oversized = await fetch(`${base}/agents/mutation-preview`, { method: "POST", headers,
      body: JSON.stringify({ action: "block", mutationScope: "bulk", selectionId: first.selection.id }) });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ code: "bulk_target_limit" });
    const filtered = await read("/agent-inventory?limit=50&blocked=false");
    expect(filtered.counts).toMatchObject({ total, filtered: 5000, packageTargets: 5000 });
    const previewResponse = await fetch(`${base}/agents/mutation-preview`, { method: "POST", headers,
      body: JSON.stringify({ action: "block", mutationScope: "bulk", selectionId: filtered.selection.id }) });
    expect(previewResponse.status, await previewResponse.clone().text()).toBe(200);
    const preview = await previewResponse.json();
    console.info("LARGE_INVENTORY_PHASE", "preview", Math.round(performance.now() - started));
    expect(preview.summary).toMatchObject({ targetCount: 5000, additionalTargetCount: 4980 });
    expect(preview.summary.targets).toHaveLength(20);
    const identity = await reportIdentity(fixture.runtime, user);
    const job = await new InventoryMutationStages(fixture.runtime).submit(identity, {
      action: "block", scope: "bulk", requestPath: "/agents/block", selectionId: filtered.selection.id,
      confirmationHash: preview.confirmationHash, idempotencyKey: randomUUID(),
    });
    const metadata = await read(`/agents/bulk-jobs/${job.id}`);
    expect(metadata).toMatchObject({ total: 5000, queued: 5000, completed: 0, status: "queued" });
    expect(metadata).not.toHaveProperty("results");
    expect(metadata).not.toHaveProperty("result");
    const items = await read(`/agents/bulk-jobs/${job.id}/items?limit=50`);
    expect(items.value).toHaveLength(50);
    expect(items.counts.total).toBe(5000);
    expect(items.page.nextCursor).toEqual(expect.any(String));
    expect((await fetch(`${base}/agents/bulk-jobs/${job.id}`, { headers: { cookie } })).status).toBe(404);
    trace.mockRestore();
    process.stdout.write("LARGE_INVENTORY_HTTP " + JSON.stringify({ sources: total, pages, targets: metadata.total,
      itemPage: items.value.length, elapsedMs: Math.round(performance.now() - started), providerMutations: 0 }) + "\n");
  }, 120_000);
});
