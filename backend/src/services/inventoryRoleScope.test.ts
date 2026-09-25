import { describe, expect, it } from "vitest";
import { inventoryProviderRoleIds, inventoryQueryTypes, inventoryRoleScope, normalizeInventoryProviderRoleIds, resourceTypesForInventoryScope } from "./inventoryRoleScope.js";
import { powerPlatformResourceTypes } from "../types/powerPlatformInventory.js";

describe("Power Platform provider role scope", () => {
  it("maps only documented role-template IDs with full scope taking precedence", () => {
    expect(inventoryRoleScope({ providerRoleIds: [inventoryProviderRoleIds.aiReader] })).toBe("ai");
    expect(inventoryRoleScope({ providerRoleIds: [inventoryProviderRoleIds.aiAdministrator, inventoryProviderRoleIds.globalReader] })).toBe("full");
    expect(inventoryRoleScope({ providerRoleIds: ["00000000-0000-0000-0000-000000000000"] })).toBe("unknown");
    expect(inventoryRoleScope({})).toBe("unknown");
  });

  it("rejects malformed or excessive claims and narrows AI resource types", () => {
    expect(normalizeInventoryProviderRoleIds([inventoryProviderRoleIds.aiReader, inventoryProviderRoleIds.aiReader, 1, "not-a-guid"])).toEqual([inventoryProviderRoleIds.aiReader]);
    expect(normalizeInventoryProviderRoleIds(Array.from({ length: 65 }, () => inventoryProviderRoleIds.globalReader))).toEqual([]);
    expect(resourceTypesForInventoryScope("ai")).toEqual([
      "microsoft.copilotstudio/agents",
      "microsoft.powerplatform/environments",
    ]);
  });

  it.each(["full", "ai", "unknown"] as const)("keeps supported request plans identical for the %s role hint", scope => {
    expect(resourceTypesForInventoryScope(scope)).toEqual(powerPlatformResourceTypes);
    expect(inventoryQueryTypes(scope, powerPlatformResourceTypes)).toEqual(powerPlatformResourceTypes);
    for (const type of powerPlatformResourceTypes) expect(inventoryQueryTypes(scope, [type])).toEqual([type]);
  });

  it("normalizes mixed-case claims deterministically without changing their source", () => {
    const claims = [inventoryProviderRoleIds.aiReader.toUpperCase(), inventoryProviderRoleIds.globalReader,
      inventoryProviderRoleIds.aiReader];
    const original = [...claims];
    expect(normalizeInventoryProviderRoleIds(claims)).toEqual([
      inventoryProviderRoleIds.aiReader, inventoryProviderRoleIds.globalReader,
    ].sort());
    expect(inventoryRoleScope({ providerRoleIds: claims })).toBe("full");
    expect(claims).toEqual(original);
  });
});
