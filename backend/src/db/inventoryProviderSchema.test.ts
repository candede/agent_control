import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { inventoryInput } from "../../scripts/inventoryFixtures.js";
import { selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import { InventoryQueries } from "./inventoryQueries.js";
import { PowerPlatformRefreshJobs } from "./powerPlatformRefreshJobs.js";
import { verifySchema } from "./schema.js";
import { PowerPlatformResourceQueryClient } from "../services/powerPlatformResourceQuery.js";
import { StreamedInventory } from "../services/streamedInventory.js";
import { completeInventoryJob, inventoryJobInput } from "../services/inventoryRuntime.js";

describe("published inventory provider metadata", () => {
  let fixture: Awaited<ReturnType<typeof testDatabase>>;
  beforeAll(async () => { fixture = await testDatabase(); }, 30_000);
  afterAll(async () => { await fixture?.close(); });

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
