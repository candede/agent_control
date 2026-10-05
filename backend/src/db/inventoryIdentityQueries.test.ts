import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { nativeInventoryFixture } from "../../scripts/inventoryFixtures.js";
import type { InventoryIdentityRecord } from "../services/inventoryIdentity.js";
import { InventoryIdentityQueries } from "./inventoryIdentityQueries.js";

describe("targeted current native identity evidence", () => {
  let fixture: Awaited<ReturnType<typeof testDatabase>>;
  let queries: InventoryIdentityQueries;
  const scope = { tenantId: "identity-query-tenant", principalId: "identity-reader" };
  const types = ["microsoft.copilotstudio/agents"] as const;
  const blueprint = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
  const source = (value = "Bot-A", environmentId: string | null = "ENVIRONMENT-A"): InventoryIdentityRecord => ({
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
  it("preserves opaque identifier case, requires an environment and isolates the current principal", async () => {
    await expect(resolve(source("bot-a"))).resolves.toMatchObject({ status: "resolved", matchedKind: "cds_bot_id",
      candidate: { nativeId: "case-sensitive-bot", environmentId: "environment-a" } });
    for (const value of [source("Bot-A", null), source("Bot-A", "different-environment"), source("missing")]) {
      await expect(resolve(value)).resolves.toEqual({ status: "unresolved", reason: "no_documented_exact_identifier" });
    }
    await expect(resolve(source(), "different-reader")).resolves.toEqual({ status: "unresolved", reason: "no_documented_exact_identifier" });
  });
  it("keeps blueprint parent evidence distinct from cross-source identity equivalence", async () => {
    const record: InventoryIdentityRecord = { ...source(), sourceSystem: "defender_hunting",
      identifiers: [{ kind: "entra_blueprint_id", value: blueprint.toLowerCase() }] };
    await expect(queries.read(client => queries.resolve(client, scope, types, record, { blueprintParentAcrossSources: true })))
      .resolves.toEqual({ status: "unresolved", reason: "blueprint_is_parent_not_equivalence" });
    await expect(resolve(record)).resolves.toEqual({ status: "unresolved", reason: "no_documented_cross_source_relation" });
  });
  it("rejects unscoped queries and observes replacement heads without historical native fallbacks", async () => {
    await expect(queries.read(client => queries.resolve(client, scope, [], source()))).rejects.toMatchObject({ status: 403 });
    await nativeInventoryFixture(fixture.runtime, scope,
      [{ nativeId: "replacement", environmentId: "environment-b", identifiers: [{ kind: "cds_bot_id", value: "replacement-bot" }] }]);
    await expect(resolve()).resolves.toEqual({ status: "unresolved", reason: "no_documented_exact_identifier" });
    await expect(resolve(source("replacement-bot", "environment-b"))).resolves.toMatchObject({ status: "resolved", candidate: { nativeId: "replacement" } });
  });
});
