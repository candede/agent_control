import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GenerationLease } from "../src/db/dataGenerations.js";
import { DataGenerations } from "../src/db/dataGenerations.js";
import { InventoryGenerations } from "../src/db/inventoryGenerations.js";
import { allowlistedPackage } from "../src/services/packageObservation.js";
import { StreamedInventory } from "../src/services/streamedInventory.js";
import type { CopilotPackageDetail } from "../src/types/copilotPackage.js";
import { inventoryBaseline, inventoryDelta, streamedPackageFixture } from "./inventoryFixtures.js";

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const database = new pg.Pool({ max: 4 });
  vi.spyOn(database, "query").mockRejectedValue(new Error("Unit tests must not access a database."));
  vi.spyOn(database, "connect").mockRejectedValue(new Error("Unit tests must not connect to a database."));
  const store = new InventoryGenerations(database);
  const lease: GenerationLease = {
    id: "generation", scopeId: "scope", tenantId: "synthetic-tenant", owner: "owner",
    version: 1, epoch: "0", sessionEpoch: "7", expectedRevision: "0", schemaVersion: 1,
  };
  const root = { scopeId: lease.scopeId, tenantId: lease.tenantId, baselineId: lease.id,
    revision: "1", epoch: lease.epoch, inserted: 0, closed: 0, changed: 0 };
  const epoch = vi.spyOn(DataGenerations.prototype, "sessionEpoch").mockResolvedValue(lease.sessionEpoch);
  const execute = vi.spyOn(store, "execute").mockImplementation(async (_input, _intent, work) => {
    await work(lease, new AbortController().signal);
    return root;
  });
  const visit = vi.spyOn(store, "visit").mockResolvedValue(undefined);
  const append = vi.spyOn(store, "appendBounded").mockResolvedValue(undefined);
  const accept = vi.spyOn(store, "acceptPage").mockResolvedValue(undefined);
  return { database, store, lease, root, epoch, execute, visit, append, accept };
}

describe("inventory generation fixtures without a database", () => {
  it.each([0, 1, 100, 101, 201])("uses the current session epoch and preserves baseline pagination for %i rows", async count => {
    const f = fixture();
    const observedAt = new Date("2026-10-28T10:00:00Z"), expiresAt = new Date("2026-10-29T10:00:00Z");
    expect(await inventoryBaseline(f.store, "principal", count, observedAt, expiresAt)).toBe(f.root);
    expect(f.epoch).toHaveBeenCalledExactlyOnceWith("synthetic-tenant", "principal");
    expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({
      sessionEpoch: "7", observedAt, expiresAt,
    }), { domain: "packages", mode: "baseline", channel: "catalog" }, expect.any(Function), expect.any(Object));
    const pages = Math.max(1, Math.ceil(count / 100));
    expect(f.accept).toHaveBeenCalledTimes(pages);
    expect(f.visit.mock.calls.map(([, token]) => token)).toEqual(Array.from({ length: pages }, (_, index) => String(index * 100)));
    expect(f.append.mock.calls.flatMap(([, records]) => records)).toHaveLength(count);
    for (let index = 0; index < pages; index++) {
      const length = Math.min(100, count - index * 100);
      expect(f.accept.mock.calls[index]).toEqual([f.lease, {
        token: String(index * 100), nextToken: index + 1 < pages ? String((index + 1) * 100) : null,
        records: f.append.mock.calls[index][1], rawCount: length, expectedCount: count, page: index + 1,
      }, length]);
    }
  });

  it("rereads the epoch for successive baselines and exact deltas", async () => {
    const f = fixture();
    f.epoch.mockResolvedValueOnce("7").mockResolvedValueOnce("8").mockResolvedValueOnce("9");
    await inventoryBaseline(f.store, "principal", 2);
    await inventoryBaseline(f.store, "principal", 2);
    const after = vi.fn(async (_lease: GenerationLease) => {
      expect(f.append).toHaveBeenCalledTimes(3);
    });
    expect(await inventoryDelta(f.store, "principal", 2, after)).toBe(f.root);
    expect(f.execute.mock.calls.map(([input]) => input.sessionEpoch)).toEqual(["7", "8", "9"]);
    expect(f.epoch).toHaveBeenCalledTimes(3);
    expect(f.epoch).toHaveBeenLastCalledWith("synthetic-tenant", "principal");
    expect(f.execute.mock.calls[2][1]).toEqual({
      domain: "packages", mode: "delta", channel: "exact", targets: ["package-000000", "package-000001"],
    });
    expect(f.append.mock.calls[2][1].map(record => record.display_name)).toEqual(["Changed 0", "Changed 1"]);
    expect(after).toHaveBeenCalledExactlyOnceWith(f.lease);
  });

  it.each(["baseline", "delta"] as const)("propagates %s epoch lookup failures before starting publication", async mode => {
    const f = fixture(), error = new Error("synthetic epoch failure");
    f.epoch.mockRejectedValue(error);
    const result = mode === "baseline" ? inventoryBaseline(f.store, "principal", 1) : inventoryDelta(f.store, "principal", 1);
    await expect(result).rejects.toBe(error);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.append).not.toHaveBeenCalled();
  });

  it("propagates a delta callback failure", async () => {
    const f = fixture(), error = new Error("synthetic callback failure");
    await expect(inventoryDelta(f.store, "principal", 1, async () => { throw error; })).rejects.toBe(error);
  });
});

describe("streamed package fixture provider contracts", () => {
  it.each(["ordinary-package", "packages", "folder/package ?#%"])("keeps collection and exact reads distinct for %s", async id => {
    const f = fixture(), scope = { tenantId: "tenant", principalId: "principal" };
    const value = allowlistedPackage({ id, displayName: "Agent", isBlocked: false });
    const catalog: CopilotPackageDetail[] = [], exact: CopilotPackageDetail[] = [];
    const catalogRead = vi.spyOn(StreamedInventory.prototype, "graphCatalog").mockImplementation(async function (this: StreamedInventory, _input, token) {
      for await (const page of this.graph.catalogPages(token, { visit: async () => {} })) catalog.push(...page.records);
      return f.root;
    });
    const exactRead = vi.spyOn(StreamedInventory.prototype, "exact").mockImplementation(async function (this: StreamedInventory, _input, token, ids) {
      for (const target of ids) exact.push(await this.graph.getPackageDetails(token, target));
      return { ...f.root, revision: "2" };
    });
    expect(await streamedPackageFixture(f.database, scope, [value], { exact: true, tokenMode: "application" }))
      .toMatchObject({ revision: "2" });
    expect(catalog).toEqual([value]);
    expect(exact).toEqual([value]);
    expect(f.epoch).toHaveBeenCalledTimes(2);
    const input = expect.objectContaining({
      sessionEpoch: "7", scope: expect.objectContaining({ ...scope, tokenMode: "application" }),
    });
    expect(catalogRead).toHaveBeenCalledWith(input, "synthetic", expect.any(Object));
    expect(exactRead).toHaveBeenCalledWith(input, "synthetic", [id], expect.any(Object));
  });
});
