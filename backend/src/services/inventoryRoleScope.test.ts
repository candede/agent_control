import { describe, expect, it } from "vitest";
import { inventoryProviderRoleIds, inventoryRoleScope, normalizeInventoryProviderRoleIds, quarantineProviderRoleAuthorized, resourceTypesForInventoryScope } from "./inventoryRoleScope.js";

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
      "microsoft.powerapps/codeapps",
      "microsoft.powerapps/apps",
      "microsoft.powerautomate/agentflows",
      "microsoft.powerautomate/m365agentflows",
      "microsoft.copilotstudio/agents",
      "microsoft.powerplatform/environments",
      "microsoft.powerplatform/environmentgroups",
    ]);
  });

  it("authorizes quarantine only for its three documented provider roles", () => {
    expect(quarantineProviderRoleAuthorized({ providerRoleIds: [inventoryProviderRoleIds.globalAdministrator] })).toBe(true);
    expect(quarantineProviderRoleAuthorized({ providerRoleIds: [inventoryProviderRoleIds.aiAdministrator] })).toBe(true);
    expect(quarantineProviderRoleAuthorized({ providerRoleIds: [inventoryProviderRoleIds.powerPlatformAdministrator] })).toBe(true);
    expect(quarantineProviderRoleAuthorized({ providerRoleIds: [inventoryProviderRoleIds.globalReader, inventoryProviderRoleIds.aiReader] })).toBe(false);
  });
});