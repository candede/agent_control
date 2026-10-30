import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { nativeInventoryFixture } from "../../scripts/inventoryFixtures.js";
import type { InventoryIdentityRecord } from "../services/inventoryIdentity.js";
import { currentNativeInventorySql, InventoryIdentityQueries } from "./inventoryIdentityQueries.js";
import { DataGenerations } from "./dataGenerations.js";
import { powerPlatformResourceTypes } from "../types/powerPlatformInventory.js";

describe("targeted current native identity evidence", () => {
  let fixture: Awaited<ReturnType<typeof testDatabase>>;
  let queries: InventoryIdentityQueries;
  const scope = { tenantId: "identity-query-tenant", principalId: "identity-reader" };
  const types = ["microsoft.copilotstudio/agents"] as const;
  const blueprint = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
  const source = (value = "Bot-A", environmentId: string | null = "environment-a"): InventoryIdentityRecord => ({
    tenantId: scope.tenantId, nativeId: "audit-row", environmentId, sourceSystem: "power_platform",
    resourceType: types[0], identifiers: [{ kind: "cds_bot_id", value }],
  });
  const resolve = (record = source(), principalId = scope.principalId) => queries.read(client =>
    queries.resolve(client, { ...scope, principalId }, types, record));
  beforeAll(async () => {
    fixture = await testDatabase();
    queries = new InventoryIdentityQueries(fixture.runtime);
    await nativeInventoryFixture(fixture.runtime, scope, [
      ...Array.from({ length: 21 }, (_, index) => ({ nativeId: `native-${index.toString().padStart(2, "0")}`, environmentId: "environment-a",
        identifiers: [{ kind: "cds_bot_id" as const, value: "Bot-A" }, { kind: "entra_blueprint_id" as const, value: blueprint }] })),
      { nativeId: "case-sensitive-bot", environmentId: "environment-a", identifiers: [{ kind: "cds_bot_id", value: "bot-a" }] },
    ]);
  });
  afterAll(async () => { await fixture?.close(); });
  it("returns twenty ambiguity examples with the exact SQL candidate count", async () => {
    const result = await resolve();
    expect(result).toMatchObject({ status: "ambiguous", candidateCount: 21, candidatesTruncated: true });
    if (result.status !== "ambiguous") throw new Error("expected_ambiguity");
    expect(result.candidates).toHaveLength(20);
    expect(result.candidates[0].nativeId).toBe("native-00");
    expect(result.candidates[19].nativeId).toBe("native-19");
  });
  it("preserves opaque identifier case, requires an environment and shares evidence only within the tenant", async () => {
    await expect(resolve(source("bot-a"))).resolves.toMatchObject({ status: "resolved", matchedKind: "cds_bot_id",
      candidate: { nativeId: "case-sensitive-bot", environmentId: "environment-a" } });
    for (const value of [source("Bot-A", null), source("Bot-A", "ENVIRONMENT-A"), source("Bot-A", "different-environment"), source("missing")]) {
      await expect(resolve(value)).resolves.toEqual({ status: "unresolved", reason: "no_documented_exact_identifier" });
    }
    await expect(resolve(source(), "different-reader")).resolves.toEqual(await resolve());
    const foreign = { ...scope, tenantId: "foreign-identity-tenant" };
    await expect(queries.read(client => queries.resolve(client, foreign, types, { ...source(), tenantId: foreign.tenantId })))
      .resolves.toEqual({ status: "unresolved", reason: "no_documented_exact_identifier" });
  });
  it("keeps blueprint parent evidence distinct from cross-source identity equivalence", async () => {
    const record: InventoryIdentityRecord = { ...source(), sourceSystem: "defender_hunting",
      identifiers: [{ kind: "entra_blueprint_id", value: blueprint.toLowerCase() }] };
    await expect(queries.read(client => queries.resolve(client, scope, types, record, { blueprintParentAcrossSources: true })))
      .resolves.toEqual({ status: "unresolved", reason: "blueprint_is_parent_not_equivalence" });
    await expect(resolve(record)).resolves.toEqual({ status: "unresolved", reason: "no_documented_cross_source_relation" });
  });
  it.each(powerPlatformResourceTypes)("retains both native types after a narrowed empty %s refresh", async resourceType => {
    const retainedScope = { ...scope, tenantId: `identity-retained-${resourceType}` };
    const environmentType = "microsoft.powerplatform/environments";
    await nativeInventoryFixture(fixture.runtime, retainedScope, [
      { nativeId: "retained-agent", environmentId: "environment-a", identifiers: [{ kind: "cds_bot_id", value: "retained-bot" }] },
      { nativeId: "environment-a", type: environmentType, environmentId: null, identifiers: [] },
    ], { resourceTypes: [...powerPlatformResourceTypes] });
    await nativeInventoryFixture(fixture.runtime, retainedScope, [], { resourceTypes: [resourceType] });
    const current = await queries.read(client => client.query(`${currentNativeInventorySql}
      SELECT native_id,resource_type FROM native ORDER BY resource_type,native_id`,
    [retainedScope.tenantId, retainedScope.principalId, [...powerPlatformResourceTypes]]));
    expect(current.rows).toEqual([
      { native_id: "retained-agent", resource_type: types[0] },
      { native_id: "environment-a", resource_type: environmentType },
    ]);
    await expect(queries.read(client => queries.resolve(client, retainedScope, types,
      { ...source("retained-bot"), tenantId: retainedScope.tenantId })))
      .resolves.toMatchObject({ status: "resolved", candidate: { nativeId: "retained-agent" } });
  });
  it("rejects unscoped queries, preserves unseen current membership and never falls back to retired heads", async () => {
    await expect(queries.read(client => queries.resolve(client, scope, [], source()))).rejects.toMatchObject({ status: 403 });
    const replacement = await nativeInventoryFixture(fixture.runtime, scope,
      [{ nativeId: "replacement", environmentId: "environment-b", identifiers: [{ kind: "cds_bot_id", value: "replacement-bot" }] }]);
    await expect(resolve()).resolves.toMatchObject({ status: "ambiguous", candidateCount: 21, candidatesTruncated: true });
    await expect(resolve(source("replacement-bot", "environment-b"))).resolves.toMatchObject({ status: "resolved", candidate: { nativeId: "replacement" } });
    await new DataGenerations(fixture.runtime).invalidate(replacement.scopeId, scope.tenantId);
    await expect(resolve()).resolves.toEqual({ status: "unresolved", reason: "no_documented_exact_identifier" });
    await expect(resolve(source("replacement-bot", "environment-b"))).resolves.toEqual({ status: "unresolved", reason: "no_documented_exact_identifier" });
  });
});
