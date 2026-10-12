import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { inventoryInput, inventorySelectionFixture, nativeInventoryFixture, reconcileInventoryFixture, streamedPackageFixture } from "../../scripts/inventoryFixtures.js";
import { selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import { InventoryQueries } from "./inventoryQueries.js";
import { PowerPlatformRefreshJobs } from "./powerPlatformRefreshJobs.js";
import { verifySchema } from "./schema.js";
import { PowerPlatformResourceQueryClient } from "../services/powerPlatformResourceQuery.js";
import { GraphPackagesClient } from "../services/graphPackages.js";
import { StreamedInventory } from "../services/streamedInventory.js";
import { completeInventoryJob, inventoryJobInput } from "../services/inventoryRuntime.js";
import { inventoryPresentation } from "../services/inventoryPresentation.js";
import { allowlistedPackage } from "../services/packageObservation.js";
import { powerPlatformInventoryRecord, restoreInventoryRecord } from "../services/inventoryRecordProjection.js";
import { InventoryGenerations, inventorySelector } from "./inventoryGenerations.js";
import type { InventoryFact } from "../services/inventoryRecordProjection.js";
import { tinyNativePages } from "../services/inventoryProviderTestSupport.js";

describe("published inventory provider metadata", () => {
  let fixture: Awaited<ReturnType<typeof testDatabase>>;
  beforeAll(async () => { fixture = await testDatabase(); }, 30_000);
  afterAll(async () => { await fixture?.close(); });

  it("stores real-shaped Graph provider telemetry and exposes sharing counts without recipient identities", async () => {
    const scope = { tenantId: randomUUID(), principalId: randomUUID() };
    const raw = { id: "T_graph-observed", displayName: "Agent", isBlocked: false, availableTo: "allowedForAll",
      deployedTo: "acquiredForNone", ownerId: "owner", agentIdentityId: null, activeUsers: 3, totalSessions: 5,
      totalRunTimeInHours: 0.1, exceptionRate: 0, lastUsedDateTime: "2026-10-05T00:00:00Z",
      sharedWithUsersAndGroups: [{ resourceId: "private-recipient", resourceType: "user" }],
      allowedUsersAndGroups: [], acquireUsersAndGroups: [] };
    const input = inventoryInput(scope.principalId);
    input.scope.tenantId = scope.tenantId;
    await new StreamedInventory(fixture.runtime, new GraphPackagesClient(async () => Response.json({ value: [raw], "@odata.count": 1 }),
      { minimumReadIntervalMs: 0, maxAttempts: 1 })).graphCatalog(input, "fixture", { authorize: async () => {} });
    await reconcileInventoryFixture(fixture.runtime, scope);
    const selected = await inventorySelectionFixture(fixture.runtime, scope);
    try {
      const result = inventoryPresentation(selected.raw).value[0];
      expect(result.packages[0]).toMatchObject({ ownerId: "owner", agentIdentityId: null,
        providerUsage: { activeUsers: 3, totalSessions: 5, totalRunTimeInHours: 0.1, exceptionRate: 0 } });
      expect(result.usage?.activeUsers).toBeNull();
      const detail = await selected.queries.packageDetail(selected.selection.id, selected.identity, raw.id);
      expect(detail.principalCounts).toEqual({ sharedWithUsersAndGroups: 1, allowedUsersAndGroups: 0, acquireUsersAndGroups: 0 });
      expect(JSON.stringify(detail)).not.toContain("private-recipient");
      expect(detail.providerUsage).toEqual(result.packages[0].providerUsage);
    } finally { await selected.queries.selections.invalidate(selected.selection.id, selected.identity); }
  });

  it("publishes and rehydrates true -> false -> true maker sharing independently of unchanged Graph packages", async () => {
    const scope = { tenantId: randomUUID(), principalId: randomUUID() }, environmentId = randomUUID(), nativeId = randomUUID();
    const packageValue = allowlistedPackage({ id: "T_shared-agent", displayName: "Agent", isBlocked: false,
      availableTo: "allowedForAll", deployedTo: "acquiredForNone", sharedWithUsersAndGroups: [],
      allowedUsersAndGroups: [], acquireUsersAndGroups: [],
      elementDetails: [{ elementType: "AgentMetadatas", elements: [{ id: "metadata", definition: JSON.stringify({
        SourceIds: { EnvironmentId: environmentId, CdsBotId: nativeId },
      }) }] }] });
    await streamedPackageFixture(fixture.runtime, scope, [packageValue], { exact: true });
    const observations = new Set<string>();
    for (const entireTenant of [true, false, true, undefined]) {
      const provider = new PowerPlatformResourceQueryClient(async () => Response.json({
        totalRecords: 1, count: 1, resultTruncated: false, data: [{
          tenantId: scope.tenantId, name: nativeId, type: "microsoft.copilotstudio/agents", id: `/resources/${nativeId}`,
          properties: { environmentId, botId: nativeId, displayName: "Agent", createdIn: "Copilot Studio Lite",
            ...(entireTenant === undefined ? {} : { sharedWithViewers: { entireTenant, userCount: 0, groupCount: 0 },
              sharedWithEditors: { userCount: 1, groupCount: 0 } }),
            harness: "Copilot Chat", titleId: packageValue.id, instructionsCharactersCount: 5508,
            componentsCounts: { knowledgeByType: {}, topics: 1, tools: 0, connectedAgents: 0, knowledge: 0 },
            capabilitiesCounts: { distinctFlows: 0 }, flows: [], triggers: [], isWebSearchEnabledForKnowledge: false,
          },
        }],
      }));
      const value = (await tinyNativePages(provider, "fixture", ["microsoft.copilotstudio/agents"])).resources[0];
      const root = await nativeInventoryFixture(fixture.runtime, scope, [value]);
      const stored = (await fixture.runtime.query(`SELECT residual,content_hash,maker_org_wide_chat FROM power_platform_record_rows
        WHERE generation_id=$1`, [root.baselineId])).rows[0];
      expect(stored.maker_org_wide_chat).toBe(entireTenant ?? null);
      observations.add(JSON.stringify(stored.residual.details));
      const facts = (await fixture.runtime.query<InventoryFact>(`SELECT kind,value,payload FROM inventory_facts WHERE generation_id=$1
        ORDER BY ordinal`, [root.baselineId])).rows;
      expect(restoreInventoryRecord(stored.residual, facts, "power_platform")).toEqual(value);
      await reconcileInventoryFixture(fixture.runtime, scope);
      const selected = await inventorySelectionFixture(fixture.runtime, scope);
      try {
        const result = inventoryPresentation(selected.raw).value[0];
        expect(result.identity.state).toBe("matched");
        expect(result.powerPlatformResource?.details).toMatchObject({
          harness: "Copilot Chat", instructionsCharactersCount: 5508, flowReferenceCount: 0, triggerCount: 0,
        });
        expect(result.powerPlatformResource?.details.makerSharing?.viewers?.entireTenant).toBe(entireTenant);
        expect(result.packages[0].availableTo).toBe("allowedForAll");
        const detail = await selected.queries.packageDetail(selected.selection.id, selected.identity, packageValue.id);
        expect(detail.principalCounts).toEqual({ sharedWithUsersAndGroups: 0, allowedUsersAndGroups: 0, acquireUsersAndGroups: 0 });
        expect(detail).not.toHaveProperty("sharedWithUsersAndGroups");
      } finally { await selected.queries.selections.invalidate(selected.selection.id, selected.identity); }
    }
    expect(observations.size).toBe(3);
  });

  it("rejects malformed maker sharing at the fresh database boundary", async () => {
    await verifySchema(fixture.runtime);
    for (const sharing of [
      { viewers: { entireTenant: "true" } }, { viewers: { userCount: -1 } },
      { editors: { entireTenant: true } }, { viewers: { groupCount: 1.5 } },
      { viewers: { userCount: Number.MAX_SAFE_INTEGER + 1 } }, { viewers: { userCount: [] } }, null,
    ]) {
      expect((await fixture.runtime.query("SELECT inventory_maker_sharing_valid($1::jsonb) AS valid", [JSON.stringify(sharing)])).rows[0].valid).toBe(false);
    }
    const scope = { tenantId: randomUUID(), principalId: randomUUID() };
    const provider = new PowerPlatformResourceQueryClient(async () => Response.json({ totalRecords: 1, count: 1,
      resultTruncated: false, data: [{ tenantId: scope.tenantId, name: "agent", type: "microsoft.copilotstudio/agents", properties: {} }] }));
    const native = (await tinyNativePages(provider, "fixture")).resources[0];
    const record = powerPlatformInventoryRecord(native);
    record.residual.details = { makerSharing: { viewers: { entireTenant: "true" } } };
    const input = inventoryInput(scope.principalId, "power_platform");
    input.scope.tenantId = scope.tenantId;
    const store = new InventoryGenerations(fixture.runtime);
    const intent = { domain: "power_platform" as const, mode: "baseline" as const, channel: "catalog" as const,
      resourceTypes: ["microsoft.copilotstudio/agents"] as const, roleScope: "full" as const };
    input.scope.selector = inventorySelector(intent);
    await expect(store.execute(input, intent, async lease => {
      await store.visit(lease, "invalid-sharing");
      await store.appendBounded(lease, [record]);
    }, { authorize: async () => {} })).rejects.toMatchObject({ code: "23514", constraint: "power_platform_record_rows_maker_sharing_check" });
  });

  it("commits native omission counts with source/job success and retains catalogue page metadata through compaction", async () => {
    await verifySchema(fixture.runtime);
    const scope = { tenantId: randomUUID(), principalId: randomUUID() };
    const environmentId = randomUUID(), types = ["microsoft.copilotstudio/agents"] as const;
    const jobs = new PowerPlatformRefreshJobs(fixture.runtime);
    const job = await jobs.submit(scope, { roleScope: "full", requestedTypes: types,
      environmentScope: environmentId, idempotencyKey: randomUUID() });
    expect(await jobs.markRunning(scope, job.id)).toBe(true);
    const input = await inventoryJobInput(fixture.runtime, scope, "power_platform", job.id,
      { environmentId, resourceTypes: types });
    const provider = new PowerPlatformResourceQueryClient(async (_url, init) => {
      const second = Boolean(JSON.parse(String(init!.body)).Options.SkipToken);
      return Response.json({ totalRecords: 2, count: 1, resultTruncated: !second, ignoredPageField: true,
        ...(!second ? { skipToken: "next" } : {}), data: [{
          tenantId: scope.tenantId, name: second ? "Opaque-B" : "Opaque-A", type: types[0],
          properties: { environmentId, ignoredResourceField: true },
        }] });
    });
    const stream = new StreamedInventory(fixture.runtime, undefined, provider);
    const root = await stream.powerPlatformCatalog(input, "synthetic", types, { environmentId, roleScope: "full",
      authorize: async () => {}, completeJob: completeInventoryJob(input, "power_platform") });
    expect(await jobs.getJob(scope, job.id)).toMatchObject({
      status: "succeeded", observedCount: 2, totalRecords: 2, pageCount: 2, unknownFieldCount: 4,
    });
    const metadata = async (id: string) => (await fixture.runtime.query(`SELECT catalog_page_count,catalog_omitted_fields
      FROM inventory_roots WHERE baseline_id=$1`, [id])).rows[0];
    expect(await metadata(root.baselineId)).toEqual({ catalog_page_count: 2, catalog_omitted_fields: 4 });
    const compactInput = { ...inventoryInput(scope.principalId, "power_platform"), scope: input.scope };
    const compact = await stream.stages.compact(compactInput, root, { authorize: async () => {} });
    expect(await metadata(compact.baselineId)).toEqual({ catalog_page_count: 2, catalog_omitted_fields: 4 });
    expect((await fixture.runtime.query("SELECT page_count FROM data_generations WHERE id=$1", [compact.baselineId])).rows[0].page_count).toBe(0);
    const identity = { ...selectionIdentity, tenantId: scope.tenantId, principalId: scope.principalId };
    const queries = new InventoryQueries(fixture.runtime, "provider-metadata-fixture-secret");
    const selection = await queries.capture(identity, compact.scopeId);
    const page = await queries.page(selection.id, identity);
    expect(page.freshness.sources).toContainEqual(expect.objectContaining({
      scope_id: compact.scopeId, page_count: 2, unknown_field_count: 4, role_scope: "full",
    }));
  });

});
