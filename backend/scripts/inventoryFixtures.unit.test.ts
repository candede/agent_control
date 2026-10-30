import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GenerationLease } from "../src/db/dataGenerations.js";
import { DataGenerations } from "../src/db/dataGenerations.js";
import { InventoryGenerations } from "../src/db/inventoryGenerations.js";
import { InventoryReconciliation } from "../src/services/inventoryReconciliation.js";
import { InventoryRuntime } from "../src/services/inventoryRuntime.js";
import { powerPlatformInventoryRecord } from "../src/services/inventoryRecordProjection.js";
import { allowlistedPackage } from "../src/services/packageObservation.js";
import { StreamedInventory } from "../src/services/streamedInventory.js";
import type { CopilotPackageDetail } from "../src/types/copilotPackage.js";
import type { PowerPlatformResource } from "../src/types/powerPlatformInventory.js";
import { inventoryBaseline, inventoryDelta, nativeInventoryFixture, refreshInventoryFixture, streamedPackageFixture } from "./inventoryFixtures.js";

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
  const execute = vi.spyOn(InventoryGenerations.prototype, "execute").mockImplementation(async (_input, _intent, work) => {
    await work(lease, new AbortController().signal);
    return root;
  });
  const visit = vi.spyOn(InventoryGenerations.prototype, "visit").mockResolvedValue(undefined);
  const append = vi.spyOn(InventoryGenerations.prototype, "appendBounded").mockResolvedValue(undefined);
  const accept = vi.spyOn(InventoryGenerations.prototype, "acceptPage").mockResolvedValue(undefined);
  return { database, store, lease, root, epoch, execute, visit, append, accept };
}

function nativeResource(nativeId: string, unknownFieldCount: number): PowerPlatformResource {
  return {
    nativeId, unknownFieldCount, type: "microsoft.copilotstudio/agents", environmentId: null, displayName: nativeId,
    sourceSystem: "power_platform", tenantId: "tenant", location: null, createdAt: null, createdBy: null,
    creatorType: "unknown", agentKind: "copilot_studio_agent", lifecycle: "unknown", lastPublishedAt: null,
    authoringTool: null, identityConfidence: "exact_native", provenance: {}, details: {}, identifiers: [],
  };
}

function refreshFixture(principalId = "principal", pending = true) {
  const f = fixture();
  vi.mocked(f.database.query).mockImplementation(async () => ({
    rows: [{ actor_principal_id: principalId, attempted_at: new Date(), deadline_at: new Date(Date.now() + 60_000), run_id: null }],
    rowCount: 1, command: "SELECT", oid: 0, fields: [],
  }));
  const enqueue = vi.spyOn(InventoryRuntime.prototype, "enqueue").mockResolvedValue(pending);
  const reconcile = vi.spyOn(InventoryReconciliation.prototype, "runNext").mockResolvedValue(null);
  return { ...f, enqueue, reconcile };
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
    expect(await streamedPackageFixture(f.database, scope, [value], { exact: true }))
      .toMatchObject({ revision: "2" });
    expect(catalog).toEqual([value]);
    expect(exact).toEqual([value]);
    expect(f.epoch).toHaveBeenCalledTimes(2);
    const input = expect.objectContaining({
      sessionEpoch: "7", actorPrincipalId: scope.principalId,
      scope: expect.objectContaining({ tenantId: scope.tenantId, principalId: null, kind: "tenant", tokenMode: "tenant" }),
    });
    expect(catalogRead).toHaveBeenCalledWith(input, "synthetic", expect.any(Object));
    expect(exactRead).toHaveBeenCalledWith(input, "synthetic", [id], expect.any(Object));
  });
});

describe("native inventory fixture metadata", () => {
  it.each([0, 3])("retains %i omitted fields per resource in page metadata", async omitted => {
    const f = fixture(), scope = { tenantId: "tenant", principalId: "principal" };
    const resources = [nativeResource("one", omitted), nativeResource("two", omitted)];
    expect(await nativeInventoryFixture(f.database, scope, resources)).toBe(f.root);
    expect(f.accept).toHaveBeenCalledExactlyOnceWith(f.lease,
      expect.objectContaining({ rawCount: 2, expectedCount: 2, omittedFieldCount: omitted * 2 }), 2);
    expect(f.append.mock.calls[0][1].map(record => record.residual.unknownFieldCount)).toEqual([omitted, omitted]);
  });
});

describe("refresh inventory fixture contracts", () => {
  it.each(["principal", "application-client"])("reconciles a job owned by %s using its authorizing actor", async principalId => {
    const f = refreshFixture(), scope = { tenantId: "tenant", principalId };
    f.epoch.mockImplementation(async (_tenant, principal) => principal === "principal" ? "7" : "0");
    expect(await refreshInventoryFixture(f.database, scope, "job", "packages", [])).toBe(f.root);
    const actor = { tenantId: scope.tenantId, principalId: "principal" };
    expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(actor);
    expect(f.reconcile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      actorPrincipalId: actor.principalId, sessionEpoch: "7",
      scope: expect.objectContaining({ tenantId: actor.tenantId, principalId: null, tokenMode: "tenant", source: "inventory_canonical" }),
    }), expect.any(Function));
  });

  it.each([[0, 0], [3, 4]])("retains omitted native field counts %j when completing a refresh", async (first, second) => {
    const f = refreshFixture(), scope = { tenantId: "tenant", principalId: "principal" };
    const records = [nativeResource("one", first), nativeResource("two", second)].map(powerPlatformInventoryRecord);
    expect(await refreshInventoryFixture(f.database, scope, "job", "power_platform", records,
      ["microsoft.copilotstudio/agents"])).toBe(f.root);
    expect(f.accept).toHaveBeenCalledExactlyOnceWith(f.lease,
      expect.objectContaining({ omittedFieldCount: first + second }), 2);
  });

  it.each([-1, 0.5, NaN, Infinity, "3", undefined])("rejects invalid omitted field counts %s before starting a refresh", async count => {
    const f = refreshFixture();
    const record = powerPlatformInventoryRecord(nativeResource("one", 0));
    record.residual.unknownFieldCount = count;
    await expect(refreshInventoryFixture(f.database, { tenantId: "tenant", principalId: "principal" },
      "job", "power_platform", [record], ["microsoft.copilotstudio/agents"])).rejects.toThrow("tiny_native_fixture_omitted_count");
    expect(f.database.query).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it("rejects a refresh without an authorizing actor before publication", async () => {
    const f = refreshFixture("");
    await expect(refreshInventoryFixture(f.database, { tenantId: "tenant", principalId: "application-client" }, "job", "packages", []))
      .rejects.toThrow("synthetic_refresh_requires_actor");
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it("returns the source root when there is no reconciliation work", async () => {
    const f = refreshFixture("principal", false), scope = { tenantId: "tenant", principalId: "principal" };
    expect(await refreshInventoryFixture(f.database, scope, "job", "packages", [])).toBe(f.root);
    expect(f.reconcile).not.toHaveBeenCalled();
  });

  it("does not enqueue reconciliation after a source publication failure", async () => {
    const f = refreshFixture(), error = new Error("synthetic publication failure");
    f.execute.mockRejectedValue(error);
    await expect(refreshInventoryFixture(f.database, { tenantId: "tenant", principalId: "principal" }, "job", "packages", []))
      .rejects.toBe(error);
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.reconcile).not.toHaveBeenCalled();
  });
});
