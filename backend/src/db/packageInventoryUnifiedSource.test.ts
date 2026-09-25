import { afterEach, describe, expect, it, vi } from "vitest";
import { allowlistedPackage } from "../services/packageObservation.js";
import { resolvePackageAgentLinks } from "../services/packageAgentIdentity.js";
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
  read_started_at: new Date("2026-09-22T00:00:00.000Z"),
  expires_at: new Date("2026-10-22T00:00:00.000Z"),
};
const exact = {
  snapshot_id: "22222222-2222-4222-8222-222222222222",
  observed_at: new Date("2026-09-23T00:00:00.000Z"),
  read_started_at: new Date("2026-09-23T00:00:00.000Z"),
  expires_at: new Date("2026-10-23T00:00:00.000Z"),
};
const emptyResult = { command: "SELECT", rowCount: 0, oid: 0, fields: [], rows: [] };

function packageValue(id: string, isBlocked = false) {
  return allowlistedPackage({ id, displayName: id, isBlocked });
}

function controlRow(package_data: CopilotPackageDetail) {
  return {
    id: exact.snapshot_id, native_id: package_data.id, package_data,
    control_state: { kind: "block", isBlocked: package_data.isBlocked },
    observed_at: exact.observed_at, expires_at: exact.expires_at, identity_revalidation_required: false,
  };
}

function fixture(base: CopilotPackageDetail[], overlays: { native_id: string; package_data: CopilotPackageDetail | null }[],
  controls: CopilotPackageDetail[] = []) {
  const exactCount = overlays.filter(row => row.package_data).length;
  const query = vi.spyOn(pool, "query").mockRejectedValue(new Error("Unexpected unified package query."));
  query.mockResolvedValueOnce({ ...emptyResult, rows: [{ ...broad, observed_count: base.length, total_records: base.length }] })
    .mockResolvedValueOnce({ ...emptyResult, rows: base.map(package_data => ({ native_id: package_data.id, package_data })) })
    .mockResolvedValueOnce({ ...emptyResult, rows: overlays.map(row => ({ ...exact, ...row })) })
    .mockResolvedValueOnce(emptyResult)
    .mockResolvedValueOnce({ ...emptyResult, rows: [
      { id: broad.id, observed_count: base.length, total_records: base.length, stored_count: base.length, page_count: 1 },
      ...(overlays.length ? [{ id: exact.snapshot_id, observed_count: exactCount, total_records: exactCount, stored_count: exactCount, page_count: 1 }] : []),
    ] }).mockResolvedValueOnce({ ...emptyResult, rows: controls.map(controlRow) });
  return { query, repository: new PackageInventoryRepository() };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("unified package observation keys", () => {
  it.each(["__proto__", "constructor", "toString", "ordinary-id"])(
    "keeps exact-only observation metadata enumerable for native ID %s", async id => {
      const value = packageValue(id);
      const { query, repository } = fixture([], [{ native_id: id, package_data: value }]);

      const result = await repository.readUnifiedSource(scope);

      expect(result.packages).toEqual([{ ...value, detailFreshness: { state: "missing", observedAt: null, expiresAt: null } }]);
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
      expect(query).toHaveBeenCalledTimes(6);
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

    expect(result.packages).toEqual([replacement, retained].map(value => ({
      ...value, detailFreshness: { state: "missing", observedAt: null, expiresAt: null },
    })));
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

  it.each(["broad", "exact"])("does not qualify uncollected %s catalog metadata as cached detail evidence", async kind => {
    const value = { ...packageValue("package"), manifestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      elementDetails: [{ elementType: "DeclarativeCopilots", elements: [{ id: "agent", definition: "{}" }] }] };
    const { repository } = fixture(kind === "broad" ? [value] : [], kind === "exact"
      ? [{ native_id: value.id, package_data: value }] : []);
    const result = await repository.readUnifiedSource(scope);
    expect(result.packages[0]).toMatchObject({ detailFreshness: { state: "missing" } });
    expect(result.packages[0]).not.toHaveProperty("elementDetails");
    expect(result.packages[0]).not.toHaveProperty("identityDetailsCollected");
    expect(result.observations[value.id]).not.toHaveProperty("identityDetails");
    expect(resolvePackageAgentLinks(scope.tenantId, result.packages, [])[0]).not.toHaveProperty("grouping");
  });

  it.each(["unified", "detail", "batch", "list"] as const)(
    "does not qualify control-only readbacks as collected identity in %s reads", async reader => {
      const detail = allowlistedPackage({
        id: "control-only", displayName: "Control-only package", isBlocked: true,
        manifestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", elementTypes: ["DeclarativeCopilots"],
        elementDetails: [{ elementType: "DeclarativeCopilots", elements: [{ id: "agent", definition: "{}" }] }],
      });
      expect(resolvePackageAgentLinks(scope.tenantId, [detail], [])[0]).toHaveProperty("grouping");
      const { query, repository } = fixture([], [], [detail]);
      const controls = { ...emptyResult, rows: [controlRow(detail)] };
      let value: CopilotPackageDetail | null | undefined;
      if (reader === "unified") {
        value = (await repository.readUnifiedSource(scope)).packages[0];
      } else {
        query.mockReset().mockRejectedValue(new Error("Unexpected control-only package query."));
        if (reader === "detail") {
          query.mockResolvedValueOnce(emptyResult).mockResolvedValueOnce(controls);
          value = (await repository.get(scope, detail.id))?.package;
        } else if (reader === "batch") {
          query.mockResolvedValueOnce({ ...emptyResult, rows: [{
            requested_id: detail.id, package_data: null, identity_data: null, read_started_at: null,
          }] }).mockResolvedValueOnce(controls);
          value = (await repository.getMany(scope, [detail.id]))[0].package;
        } else {
          query.mockResolvedValueOnce({ ...emptyResult, rows: [broad] })
            .mockResolvedValueOnce({ ...emptyResult, rows: [{
              native_id: detail.id, package_data: null, identity_data: null, read_started_at: broad.read_started_at,
            }] }).mockResolvedValueOnce(controls)
            .mockResolvedValueOnce({ ...emptyResult, rows: [{ total: 1, allowed: 0, blocked: 1 }] })
            .mockResolvedValueOnce({ ...emptyResult, rows: [{ native_id: detail.id }] });
          value = (await repository.list(scope)).value[0];
        }
      }
      expect(value).toMatchObject({
        id: detail.id, isBlocked: true, controlObservations: { block: { snapshotId: exact.snapshot_id } },
        detailFreshness: { state: "missing", observedAt: null, expiresAt: null },
      });
      expect(value).not.toHaveProperty("elementDetails");
      expect(value).not.toHaveProperty("identityDetailsCollected");
      expect(resolvePackageAgentLinks(scope.tenantId, [value!], [])[0]).not.toHaveProperty("grouping");
    },
  );

  it.each(["unified", "detail", "batch", "list"].flatMap(reader =>
    ["identity", "access"].map(evidence => ({ reader, evidence })),
  ))("preserves newer catalog $evidence evidence in $reader reads", async ({ reader, evidence }) => {
    const now = Date.now();
    const snapshot = { ...broad, catalog_only: true, observed_count: 1, total_records: 1,
      observed_at: new Date(now - 15 * 60_000), read_started_at: new Date(now - 15 * 60_000) };
    const summary = { ...packageValue("package"), version: "1", lastModifiedDateTime: "2026-09-22T00:00:00Z",
      manifestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", availableTo: "some", deployedTo: "some" };
    const cached = { ...summary, identityDetailsCollected: true as const,
      allowedUsersAndGroups: [{ resourceId: "old-user", resourceType: "user" }],
      acquireUsersAndGroups: [{ resourceId: "old-group", resourceType: "group" }],
      elementDetails: [{ elementType: "DeclarativeCopilots", elements: [{ id: "agent", definition: "{}" }] }] };
    const current: CopilotPackageDetail = { ...summary, ...(evidence === "identity"
      ? { elementDetails: [{ elementType: "AgentMetadatas", elements: [{ id: "metadata", definition: JSON.stringify({
        SourceIds: { EnvironmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      }) }] }] }
      : { allowedUsersAndGroups: [], acquireUsersAndGroups: [] }) };
    const detail = {
      native_id: current.id, package_data: cached, snapshot_id: exact.snapshot_id, from_cache: true,
      observed_at: new Date(now - 30 * 60_000), expires_at: new Date(now + 30 * 60_000),
    };
    const row = { ...snapshot, native_id: current.id, requested_id: current.id, package_data: current,
      identity_data: cached, identity_snapshot_id: detail.snapshot_id,
      identity_observed_at: detail.observed_at, identity_expires_at: detail.expires_at };
    const query = vi.spyOn(pool, "query").mockRejectedValue(new Error("Unexpected detail projection query."));
    const repository = new PackageInventoryRepository();
    let value: CopilotPackageDetail | null | undefined;
    if (reader === "unified") {
      query.mockResolvedValueOnce({ ...emptyResult, rows: [snapshot] })
        .mockResolvedValueOnce({ ...emptyResult, rows: [{ native_id: current.id, package_data: current }] })
        .mockResolvedValueOnce(emptyResult)
        .mockResolvedValueOnce({ ...emptyResult, rows: [detail] })
        .mockResolvedValueOnce({ ...emptyResult, rows: [{ ...snapshot, stored_count: 1 }] })
        .mockResolvedValueOnce(emptyResult);
      const result = await repository.readUnifiedSource(scope);
      value = result.packages[0];
      if (evidence === "identity") expect(result.observations[current.id]).not.toHaveProperty("identityDetails");
    } else if (reader === "list") {
      query.mockResolvedValueOnce({ ...emptyResult, rows: [snapshot] })
        .mockResolvedValueOnce({ ...emptyResult, rows: [row] })
        .mockResolvedValueOnce(emptyResult)
        .mockResolvedValueOnce({ ...emptyResult, rows: [{ total: 1, allowed: 1, blocked: 0 }] })
        .mockResolvedValueOnce({ ...emptyResult, rows: [{ native_id: current.id }] });
      value = (await repository.list(scope)).value[0];
    } else {
      query.mockResolvedValueOnce({ ...emptyResult, rows: [row] }).mockResolvedValueOnce(emptyResult);
      value = reader === "detail" ? (await repository.get(scope, current.id))?.package
        : (await repository.getMany(scope, [current.id]))[0].package;
    }
    if (evidence === "identity") {
      expect(value).toMatchObject({ detailFreshness: { state: "invalidated" }, identityRevalidationRequired: true });
      expect(value).not.toHaveProperty("elementDetails");
      expect(value).not.toHaveProperty("identityDetailsCollected");
      expect(resolvePackageAgentLinks(scope.tenantId, [value!], [])[0]).not.toHaveProperty("grouping");
    } else {
      expect(value).toMatchObject({
        allowedUsersAndGroups: [], acquireUsersAndGroups: [], detailFreshness: { state: "fresh" },
      });
    }
  });
});
