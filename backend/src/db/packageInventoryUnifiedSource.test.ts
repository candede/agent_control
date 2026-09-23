import { afterEach, describe, expect, it, vi } from "vitest";
import { allowlistedPackage } from "../services/packageObservation.js";
import type { CopilotPackageDetail } from "../types/copilotPackage.js";
import { PackageInventoryRepository } from "./packageInventory.js";
import { pool } from "./pool.js";

const scope = { tenantId: "unified-tenant", principalId: "unified-reader" };
const broad = {
  id: "11111111-1111-4111-8111-111111111111",
  token_mode: "delegated",
  scope_kind: "broad",
  requested_ids: [],
  observed_count: 0,
  total_records: 0,
  page_count: 1,
  observed_at: new Date("2026-09-22T00:00:00.000Z"),
  expires_at: new Date("2026-10-22T00:00:00.000Z"),
};
const exact = {
  snapshot_id: "22222222-2222-4222-8222-222222222222",
  observed_at: new Date("2026-09-23T00:00:00.000Z"),
  expires_at: new Date("2026-10-23T00:00:00.000Z"),
};
const emptyResult = { command: "SELECT", rowCount: 0, oid: 0, fields: [], rows: [] };

function packageValue(id: string, isBlocked = false) {
  return allowlistedPackage({ id, displayName: id, isBlocked });
}

function fixture(base: CopilotPackageDetail[], overlays: { native_id: string; package_data: CopilotPackageDetail | null }[]) {
  const exactCount = overlays.filter(row => row.package_data).length;
  const query = vi.spyOn(pool, "query").mockRejectedValue(new Error("Unexpected unified package query."));
  query.mockResolvedValueOnce({ ...emptyResult, rows: [{ ...broad, observed_count: base.length, total_records: base.length }] })
    .mockResolvedValueOnce({ ...emptyResult, rows: base.map(package_data => ({ native_id: package_data.id, package_data })) })
    .mockResolvedValueOnce({ ...emptyResult, rows: overlays.map(row => ({ ...exact, ...row })) })
    .mockResolvedValueOnce(emptyResult)
    .mockResolvedValueOnce({ ...emptyResult, rows: [
      { id: broad.id, observed_count: base.length, total_records: base.length, stored_count: base.length, page_count: 1 },
      ...(overlays.length ? [{ id: exact.snapshot_id, observed_count: exactCount, total_records: exactCount, stored_count: exactCount, page_count: 1 }] : []),
    ] });
  return { query, repository: new PackageInventoryRepository() };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("unified package observation keys", () => {
  it.each(["__proto__", "constructor", "toString", "ordinary-id"])(
    "keeps exact-only observation metadata enumerable for native ID %s", async id => {
      const value = packageValue(id);
      const { query, repository } = fixture([], [{ native_id: id, package_data: value }]);

      const result = await repository.readUnifiedSource(scope);

      expect(result.packages).toEqual([value]);
      expect(Object.keys(result.observations)).toEqual([id]);
      expect(Object.hasOwn(result.observations, id)).toBe(true);
      expect(result.observations[id]).toEqual({
        snapshotId: exact.snapshot_id, scopeKind: "exact",
        observedAt: exact.observed_at.toISOString(), expiresAt: exact.expires_at.toISOString(),
      });
      expect(JSON.parse(JSON.stringify(result.observations))).toEqual(
        Object.fromEntries([[id, result.observations[id]]]),
      );
      expect(Object.getPrototypeOf(result.observations)).toBe(Object.prototype);
      expect(query).toHaveBeenCalledTimes(5);
    },
  );

  it("preserves broad observations while replacing exact targets and removing confirmed absences", async () => {
    const retained = packageValue("retained");
    const replacement = packageValue("__proto__", true);
    const { repository } = fixture([retained, packageValue("__proto__"), packageValue("removed")], [
      { native_id: "__proto__", package_data: replacement },
      { native_id: "removed", package_data: null },
    ]);

    const result = await repository.readUnifiedSource(scope);

    expect(result.packages).toEqual([replacement, retained]);
    expect(Object.keys(result.observations).sort()).toEqual(["__proto__", "retained"]);
    expect(result.observations.retained).toMatchObject({ snapshotId: broad.id, scopeKind: "broad" });
    expect(result.observations["__proto__"]).toMatchObject({ snapshotId: exact.snapshot_id, scopeKind: "exact" });
    expect(Object.hasOwn(result.observations, "removed")).toBe(false);
  });

  it("removes a confirmed absent prototype-named target without inventing observation metadata", async () => {
    const { repository } = fixture([packageValue("__proto__")], [{ native_id: "__proto__", package_data: null }]);

    const result = await repository.readUnifiedSource(scope);

    expect(result.packages).toEqual([]);
    expect(Object.entries(result.observations)).toEqual([]);
    expect(Object.hasOwn(result.observations, "__proto__")).toBe(false);
  });

  it("still rejects a stored resource whose identity differs from its native key", async () => {
    const { repository } = fixture([], [{ native_id: "requested", package_data: packageValue("different") }]);
    await expect(repository.readUnifiedSource(scope)).rejects.toMatchObject({ code: "inventory_verification_failed" });
  });
});
