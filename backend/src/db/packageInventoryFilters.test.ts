import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { allowlistedPackage } from "../services/packageObservation.js";
import { normalizePackageAuthoringTool } from "../types/copilotPackage.js";
import { PackageInventoryRepository, packageFacets } from "./packageInventory.js";
import { pool } from "./pool.js";

const scope = { tenantId: "facet-tenant", principalId: "facet-reader" };
const query = vi.spyOn(pool, "query");
const snapshot = {
  id: "11111111-1111-4111-8111-111111111110",
  token_mode: "delegated",
  scope_kind: "broad",
  requested_ids: [],
  observed_count: 1,
  total_records: 1,
  page_count: 1,
  observed_at: new Date("2026-09-15T00:00:00.000Z"),
  expires_at: new Date("2026-09-22T00:00:00.000Z"),
};
const emptyResult = { command: "SELECT", rowCount: 0, oid: 0, fields: [], rows: [] };

beforeEach(() => {
  query.mockReset();
  query.mockRejectedValue(new Error("Unexpected database query in authoring-filter unit test."));
});

afterAll(() => {
  query.mockRestore();
});

describe("saved package authoring filters", () => {
  it.each([
    ["Copilot Studio", "copilotstudio", true],
    ["MicrosoftCopilotStudio", "copilotstudio", true],
    ["Microsoft Copilot Studio", "copilotstudio", true],
    ["Custom SDK", "customsdk", false],
    ["CustomSDK", "customsdk", false],
  ])("uses canonical filtering for %s in both counts and pages", async (platform, canonical, studio) => {
    const value = allowlistedPackage({ id: "package", displayName: "Package", isBlocked: false, platform });
    query.mockResolvedValueOnce({ ...emptyResult, rowCount: 1, rows: [snapshot] })
      .mockResolvedValueOnce({ ...emptyResult, rowCount: 1, rows: [{ total: 1, allowed: 1, blocked: 0 }] })
      .mockResolvedValueOnce({ ...emptyResult, rowCount: 1, rows: [{ package_data: value }] })
      .mockResolvedValueOnce({ ...emptyResult, rowCount: 1, rows: [{ package_data: value }] });

    const result = await new PackageInventoryRepository().list(scope, { platform, limit: 25, offset: 5 });
    expect(normalizePackageAuthoringTool(platform)).toBe(canonical);
    expect(result.facets.platforms).toEqual([{ value: studio ? "Copilot Studio" : "Custom SDK", label: studio ? "Copilot Studio" : "Custom SDK" }]);
    expect(normalizePackageAuthoringTool(result.facets.platforms[0].value)).toBe(canonical);
    expect(query).toHaveBeenCalledTimes(4);
    for (const call of [query.mock.calls[1], query.mock.calls[3]]) {
      expect(call[0]).toContain("regexp_replace(lower(COALESCE(");
      expect(call[0]).toContain(studio ? "LIKE '%' || $4 || '%'" : "=$4");
      expect(call[0]).toContain("tenant_id=$2 AND principal_id=$3");
    }
    expect(query.mock.calls[1][1]).toEqual([snapshot.id, scope.tenantId, scope.principalId, canonical]);
    expect(query.mock.calls[3][1]).toEqual([snapshot.id, scope.tenantId, scope.principalId, canonical, 25, 5]);
  });

  it.each([
    { platform: "MicrosoftCopilotStudio" },
    { shortDescription: "Built using Microsoft Copilot Studio." },
  ])("keeps facet values equivalent to saved authoring metadata for %j", fields => {
    const value = allowlistedPackage({ id: "package", displayName: "Package", isBlocked: false, ...fields });
    expect(packageFacets([value]).platforms).toEqual([{ value: "Copilot Studio", label: "Copilot Studio" }]);
  });
});

describe("saved package availability filters", () => {
  it.each([
    "all", "everyone", "allowedForAll", "availableToAll", "deployedToAll", "installedForAll",
    "some", "allowedForSome", "availableToSome", "deployedToSome", "installedForSome",
    " ALLOWED_FOR-ALL ", "AVAILABLE TO SOME",
  ])("offers the combined facet for recognized status %s", availableTo => {
    const value = allowlistedPackage({ id: "package", displayName: "Package", isBlocked: false, availableTo });
    expect(packageFacets([value]).availability).toEqual(expect.arrayContaining([
      { value: `available:${availableTo}`, label: availableTo },
      { value: "__some_or_all__", label: "Allowed for Some or All" },
    ]));
  });

  it.each([undefined, "", "none", "allowedForNoOne", "deployedToNone", "unknownFutureValue", "futureStatus"])(
    "does not offer the combined facet for status %s", availableTo => {
      const value = allowlistedPackage({ id: "package", displayName: "Package", isBlocked: false, availableTo });
      expect(packageFacets([value]).availability).toEqual([
        { value: `available:${availableTo ?? "__unknown__"}`, label: availableTo ?? "Unknown" },
      ]);
    },
  );

  it.each(["__some_or_all__", "available:__some_or_all__"])("uses case-safe shared aliases for %s in counts and pages", async availableTo => {
    const value = allowlistedPackage({ id: "package", displayName: "Package", isBlocked: false, availableTo: "allowedForAll" });
    query.mockResolvedValueOnce({ ...emptyResult, rowCount: 1, rows: [snapshot] })
      .mockResolvedValueOnce({ ...emptyResult, rowCount: 1, rows: [{ total: 1, allowed: 1, blocked: 0 }] })
      .mockResolvedValueOnce({ ...emptyResult, rowCount: 1, rows: [{ package_data: value }] })
      .mockResolvedValueOnce({ ...emptyResult, rowCount: 1, rows: [{ package_data: value }] });

    const result = await new PackageInventoryRepository().list(scope, { availableTo, limit: 25, offset: 5 });
    expect(result.count).toBe(1);
    expect(result.value).toEqual([value]);
    expect(query).toHaveBeenCalledTimes(4);
    for (const call of [query.mock.calls[1], query.mock.calls[3]]) {
      expect(call[0]).toContain("regexp_replace(lower(available_to),'[^a-z0-9]','','g')=ANY($4::text[])");
      expect(call[0]).toContain("tenant_id=$2 AND principal_id=$3");
    }
    const aliases = [
      "all", "everyone", "allowedforall", "availabletoall", "deployedtoall", "installedforall",
      "some", "allowedforsome", "availabletosome", "deployedtosome", "installedforsome",
    ];
    expect(query.mock.calls[1][1]).toEqual([snapshot.id, scope.tenantId, scope.principalId, aliases]);
    expect(query.mock.calls[3][1]).toEqual([snapshot.id, scope.tenantId, scope.principalId, aliases, 25, 5]);
  });
});
