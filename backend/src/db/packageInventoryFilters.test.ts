import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { allowlistedPackage } from "../services/packageObservation.js";
import { normalizePackageAuthoringTool, type CopilotPackageDetail } from "../types/copilotPackage.js";
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

function mockList(values: CopilotPackageDetail[]) {
  query.mockImplementation(async statement => {
    if (typeof statement !== "string") throw new Error("Expected a saved package SQL statement.");
    if (statement.startsWith("SELECT * FROM package_inventory_snapshots")) {
      return { ...emptyResult, rowCount: 1, rows: [snapshot] };
    }
    if (statement.includes("SELECT count(*)::int AS total")) {
      return { ...emptyResult, rowCount: 1, rows: [{ total: values.length, allowed: values.length, blocked: 0 }] };
    }
    if (statement.includes("SELECT package_data")) {
      return { ...emptyResult, rowCount: values.length, rows: values.map(package_data => ({ package_data })) };
    }
    throw new Error("Unexpected saved package query.");
  });
}

beforeEach(() => {
  query.mockReset();
  query.mockRejectedValue(new Error("Unexpected database query in authoring-filter unit test."));
});

afterAll(() => {
  query.mockRestore();
});

describe("saved package authoring filters", () => {
  it.each([
    ["Copilot Studio", "copilotstudio", "Copilot Studio"],
    ["MicrosoftCopilotStudio", "copilotstudio", "Copilot Studio"],
    ["Microsoft Copilot Studio", "copilotstudio", "Copilot Studio"],
    ["Custom SDK", "customsdk", "Custom SDK"],
    ["CustomSDK", "customsdk", "Custom SDK"],
    ["Copilot Studio Lite", "microsoft365copilotagentbuilder", "Microsoft 365 Copilot Agent Builder"],
    ["MicrosoftCopilotStudioLite", "microsoft365copilotagentbuilder", "Microsoft 365 Copilot Agent Builder"],
  ])("uses canonical filtering for %s in both counts and pages", async (platform, canonical, label) => {
    const value = allowlistedPackage({ id: "package", displayName: "Package", isBlocked: false, platform });
    mockList([value]);

    const result = await new PackageInventoryRepository().list(scope, { platform, limit: 25, offset: 5 });
    expect(normalizePackageAuthoringTool(platform)).toBe(canonical);
    expect(result.facets.platforms).toEqual([{ value: label, label }]);
    expect(normalizePackageAuthoringTool(result.facets.platforms[0].value)).toBe(canonical);
    expect(query).toHaveBeenCalledTimes(4);
    const filtered = query.mock.calls.filter(([statement]) => String(statement).includes("FROM scoped"));
    expect(filtered).toHaveLength(2);
    for (const call of filtered) {
      expect(call[0]).toContain("native_id=ANY($4::text[])");
      expect(call[0]).toContain("tenant_id=$2 AND principal_id=$3");
    }
    expect(filtered[0][1]).toEqual([snapshot.id, scope.tenantId, scope.principalId, [value.id]]);
    expect(filtered[1][1]).toEqual([snapshot.id, scope.tenantId, scope.principalId, [value.id], 25, 5]);
  });

  it.each([
    ["Copilot Studio", ["studio"]],
    ["Microsoft 365 Copilot Agent Builder", ["lite", "microsoft-lite", "builder", "description"]],
    ["Copilot Studio Lite", ["lite", "microsoft-lite", "builder", "description"]],
    ["Custom SDK", ["custom"]],
    ["Missing tool", []],
  ])("binds only packages belonging to the %s facet", async (platform, expectedIds) => {
    mockList([
      ...[
        ["studio", "Microsoft Copilot Studio"],
        ["lite", "Copilot Studio Lite"],
        ["microsoft-lite", "MicrosoftCopilotStudioLite"],
        ["builder", "Microsoft 365 Copilot Agent Builder"],
        ["custom", "CustomSDK"],
        ["blank", ""],
      ].map(([id, savedPlatform]) => allowlistedPackage({ id, displayName: id, isBlocked: false, platform: savedPlatform })),
      allowlistedPackage({ id: "description", displayName: "Description", isBlocked: false, shortDescription: "  Built using Copilot Studio Lite.  " }),
    ]);

    await new PackageInventoryRepository().list(scope, { platform, limit: 25, offset: 5 });
    const filtered = query.mock.calls.filter(([statement]) => String(statement).includes("FROM scoped"));
    expect(filtered).toHaveLength(2);
    expect(filtered[0][1]).toEqual([snapshot.id, scope.tenantId, scope.principalId, expectedIds]);
    expect(filtered[1][1]).toEqual([snapshot.id, scope.tenantId, scope.principalId, expectedIds, 25, 5]);
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
    mockList([value]);

    const result = await new PackageInventoryRepository().list(scope, { availableTo, limit: 25, offset: 5 });
    expect(result.count).toBe(1);
    expect(result.value).toEqual([value]);
    expect(query).toHaveBeenCalledTimes(4);
    const filtered = query.mock.calls.filter(([statement]) => String(statement).includes("FROM scoped"));
    expect(filtered).toHaveLength(2);
    for (const call of filtered) {
      expect(call[0]).toContain("regexp_replace(lower(available_to),'[^a-z0-9]','','g')=ANY($4::text[])");
      expect(call[0]).toContain("tenant_id=$2 AND principal_id=$3");
    }
    const aliases = [
      "all", "everyone", "allowedforall", "availabletoall", "deployedtoall", "installedforall",
      "some", "allowedforsome", "availabletosome", "deployedtosome", "installedforsome",
    ];
    expect(filtered[0][1]).toEqual([snapshot.id, scope.tenantId, scope.principalId, aliases]);
    expect(filtered[1][1]).toEqual([snapshot.id, scope.tenantId, scope.principalId, aliases, 25, 5]);
  });
});
