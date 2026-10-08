import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "csv-parse/sync";
import { testDatabase } from "../../scripts/testDatabase.js";
import { generationInput, selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import { fixtureDirectoryUser, publishFixtureDirectory } from "../../scripts/userSourceFixture.js";
import { inventorySelectionFixture, nativeInventoryFixture, reconcileInventoryFixture } from "../../scripts/inventoryFixtures.js";
import { inventoryPresentation } from "../services/inventoryPresentation.js";
import { DataExports } from "../services/dataExports.js";
import { inventoryExportColumns, inventoryExportSource } from "../services/inventoryExports.js";
import type { CopilotDirectoryUser } from "../types/copilotUsage.js";
import type { DataSyncScope } from "./dataSync.js";
import type { InventoryQuery } from "./inventoryQueries.js";
import { UserSourceStages } from "./userSourceStages.js";
import { DataGenerations } from "./dataGenerations.js";
import { AppError } from "../errors.js";
import { AgentPeopleRepository } from "./agentPeople.js";

const personId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const observedAt = "2026-09-15T10:00:00.000Z";
let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => { fixture = await testDatabase(); });
afterAll(async () => { await fixture?.close(); });

function directoryUser(displayName = "Saved Person", objectId = personId): CopilotDirectoryUser {
  const user = fixtureDirectoryUser(objectId, displayName, "saved#EXT#@example.onmicrosoft.com");
  user.identity.userType = "Guest";
  return user;
}
async function publish(scope: DataSyncScope, users: CopilotDirectoryUser[], expiresAt?: Date) {
  const sessionEpoch = await new DataGenerations(fixture.runtime).sessionEpoch(scope.tenantId, scope.principalId);
  return publishFixtureDirectory(fixture.runtime, { ...selectionIdentity, ...scope, sessionEpoch }, users,
    { observedAt: new Date(observedAt), ...(expiresAt ? { expiresAt } : {}) });
}
async function inventory(scope: DataSyncScope) {
  await nativeInventoryFixture(fixture.runtime, scope, [{
    nativeId: "native-agent", environmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", displayName: "Agent",
    createdBy: personId, authoringTool: "Copilot Studio", agentKind: "agent", lifecycle: "published",
    identifiers: [{ kind: "environment_id", value: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      { kind: "power_platform_resource_id", value: "native-agent" }],
    details: { ownerId: personId.toUpperCase(), lastModifiedBy: personId },
  }]);
  await reconcileInventoryFixture(fixture.runtime, scope);
}
async function selected(scope: DataSyncScope, query: InventoryQuery = {}) {
  const read = await inventorySelectionFixture(fixture.runtime, scope, query);
  return { ...read, page: inventoryPresentation(read.raw) };
}
async function exportRows(read: Awaited<ReturnType<typeof selected>>) {
  const exports = new DataExports(fixture.runtime, read.queries.selections, async () => {});
  const id = await exports.create(read.identity, { selectionId: read.selection.id, queryHash: read.selection.queryHash,
    kind: "unified_agents", filename: "synthetic-people.csv" });
  await exports.build(id, read.identity, inventoryExportColumns.unified_agents, inventoryExportSource(read.queries, read.identity));
  let csv = "";
  for await (const chunk of exports.download(id, read.identity, new AbortController().signal)) {
    csv += chunk.toString();
    expect(Buffer.byteLength(csv)).toBeLessThan(262_144);
  }
  return parse(csv, { bom: true, columns: true }) as Array<Record<string, string>>;
}

describe("selected persisted directory people", () => {
  it("persists unlicensed creators into selected SQL and durable exports, including explicit lookup outcomes", async () => {
    const scope = { tenantId: "cached-people", principalId: "private-reader" };
    await inventory(scope);
    const before = await selected(scope), cache = new AgentPeopleRepository(fixture.runtime);
    const checkedAt = new Date(Date.now() - 1_000).toISOString(), generation = await cache.generation(scope);
    await cache.save(scope, [{ objectId: personId, status: "resolved", displayName: "Unlicensed Creator",
      userPrincipalName: "unlicensed@example.invalid", checkedAt }], { generation });
    const after = await selected(scope, { search: "Unlicensed Creator", sortBy: "createdBy" });
    expect(after.page.counts.filtered).toBe(1);
    expect(after.page.value[0].id).toBe(before.page.value[0].id);
    expect(after.page.value[0].people?.createdBy?.displayName).toBe("Unlicensed Creator");
    expect(await cache.directoryIds(scope, [personId])).toEqual([]);
    expect((await exportRows(before)).find(row => row.recordType === "agent")).toMatchObject({
      createdBy: personId, createdByDisplayName: "", createdByResolutionStatus: "",
    });
    await cache.save(scope, [{ objectId: personId, status: "lookup_failed", displayName: null,
      userPrincipalName: null, checkedAt: new Date().toISOString(), errorCode: "provider_timeout" }], { generation });
    const failed = await selected(scope, { sortBy: "createdBy" }), rows = await exportRows(failed);
    expect(rows.find(row => row.recordType === "agent")).toMatchObject({
      createdBy: personId, createdByDisplayName: "Unlicensed Creator", createdByObservedAt: checkedAt,
      createdByResolutionStatus: "lookup_failed", createdByErrorCode: "provider_timeout",
    });
    await cache.save(scope, [{ objectId: personId, status: "not_found", displayName: null,
      userPrincipalName: null, checkedAt: new Date(Date.now() + 1).toISOString() }], { generation });
    expect((await selected(scope, { sortBy: "createdBy" })).page.value[0].people?.createdBy).toMatchObject({ status: "not_found", displayName: null });
  });

  it("excludes other scopes and unmatched IDs while retaining current directory evidence past freshness until revocation", async () => {
    const scope = { tenantId: "saved-people", principalId: "private-reader" };
    await inventory(scope);
    const before = await selected(scope);
    expect(before.page.value[0].people?.createdBy).toBeUndefined();
    await publish({ ...scope, tenantId: "other-tenant" }, [directoryUser("Other tenant")]);
    await publish({ ...scope, principalId: "other-reader" }, [directoryUser("Other principal")]);
    const stages = new UserSourceStages(fixture.runtime);
    await stages.execute(generationInput({ scope: { ...generationInput().scope, ...scope, source: "app_activity" } }), async lease => {
      const key = await stages.query(lease, "activity", "synthetic:empty-activity");
      await stages.finishQuery(lease, key);
    }, { beforePublish: async () => {} });
    const isolated = await selected(scope);
    expect(isolated.page.value[0].people?.createdBy).toBeUndefined();
    expect(isolated.page.value[0].id).toBe(before.page.value[0].id);
    await publish(scope, [directoryUser("Unmatched", "cccccccc-cccc-4ccc-8ccc-cccccccccccc")]);
    expect((await selected(scope)).page.value[0].people?.createdBy).toBeUndefined();
    const expiresAt = new Date(Date.now() + 1500);
    await publish(scope, [directoryUser()], expiresAt);
    const saved = await selected(scope);
    expect(saved.page.value[0].people?.owner).toMatchObject({
      objectId: personId, displayName: "Saved Person", userPrincipalName: "saved#EXT#@example.onmicrosoft.com", observedAt,
    });
    expect(saved.page.value[0].people?.createdBy).toEqual(saved.page.value[0].people?.owner);
    expect(saved.page.value[0].people?.lastModifiedBy).toEqual(saved.page.value[0].people?.owner);
    expect(saved.page.value[0].id).toBe(before.page.value[0].id);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, expiresAt.getTime() - Date.now()) + 20));
    const expired = await selected(scope);
    expect(expired.page.value[0].people?.createdBy).toEqual(saved.page.value[0].people?.createdBy);
    expect(expired.page.value[0].powerPlatformResource?.details.ownerId).toBe(personId.toUpperCase());
    expect(expired.page.value[0].id).toBe(saved.page.value[0].id);
    expect((await saved.queries.page(saved.selection.id, saved.identity)).value).toEqual(saved.raw.value);
    expect((await exportRows(saved)).find(row => row.recordType === "agent")).toMatchObject({ createdByDisplayName: "Saved Person" });
    await new DataGenerations(fixture.runtime).revokePrincipal(scope.tenantId, scope.principalId);
    await expect(saved.queries.page(saved.selection.id, saved.identity)).rejects.toMatchObject({ code: "selection_invalidated" });
    await expect(exportRows(saved)).rejects.toMatchObject({ code: "selection_invalidated" });
  });

  it("keeps an existing read pinned across same-timestamp directory replacement while new selections see the new people", async () => {
    const scope = { tenantId: "saved-people", principalId: "replacement-reader" };
    await inventory(scope);
    await publish(scope, [directoryUser()]);
    const before = await selected(scope);
    await publish(scope, [directoryUser("Replacement Person")]);
    const oldPage = inventoryPresentation(await before.queries.page(before.selection.id, before.identity));
    expect(oldPage.value[0].people?.owner?.displayName).toBe("Saved Person");
    const after = await selected(scope);
    expect(after.page.value[0].people?.owner?.displayName).toBe("Replacement Person");
    expect(after.page.value[0].id).toBe(before.page.value[0].id);
    expect(after.page.value[0].powerPlatformResource).toEqual(before.page.value[0].powerPlatformResource);
    expect(after.page.value[0].identity).toEqual(before.page.value[0].identity);
    expect((await exportRows(before)).find(row => row.recordType === "agent")?.createdByDisplayName).toBe("Saved Person");
    expect((await exportRows(after)).find(row => row.recordType === "agent")?.createdByDisplayName).toBe("Replacement Person");
  });

  it("retains a valid prior observation when denied or malformed directory replacements fail", async () => {
    const scope = { tenantId: "saved-people", principalId: "failure-reader" };
    await inventory(scope);
    await publish(scope, [directoryUser()]);
    const stages = new UserSourceStages(fixture.runtime);
    await expect(stages.execute(generationInput({ scope: { ...generationInput().scope, ...scope } }),
      async () => { throw new AppError(403, "permission_required", "Synthetic denial."); }, { beforePublish: async () => {} }))
      .rejects.toMatchObject({ code: "permission_required" });
    const retained = await selected(scope);
    expect(retained.page.value[0].people?.owner?.observedAt).toBe(observedAt);
    await expect(publish(scope, [directoryUser("Malformed", "not-a-guid")])).rejects.toMatchObject({ code: "provider_schema" });
    expect((await selected(scope)).page.value[0].people?.owner?.observedAt).toBe(observedAt);
    await publish(scope, [directoryUser()]);
    expect((await selected(scope)).page.value[0].id).toBe(retained.page.value[0].id);
  });
});
