import { describe, expect, it } from "vitest";
import { inventoryCoverageLabel, inventoryCoverageValue, inventoryRequestScope, inventoryRoleHint, savedInventoryTime } from "./inventoryVerification";

describe("saved inventory evidence labels", () => {
  it("keeps optional role hints separate from collection and permission evidence", () => {
    expect(inventoryRoleHint("unknown")).toBe("Not supplied");
    expect(inventoryRoleHint(undefined)).toBe("Not supplied");
    expect(inventoryRoleHint(null)).toBe("Not supplied");
    expect(inventoryRoleHint("ai")).toBe("AI (hint only)");
    expect(inventoryRoleHint("full")).toBe("Full (hint only)");
    expect(inventoryRequestScope(null)).toBe("All environments requested");
    expect(inventoryRequestScope("finance-env")).toBe("Environment requested: finance-env");
  });

  it("labels every coverage state without promoting absence to zero", () => {
    expect(inventoryCoverageLabel("covered")).toBe("Authorized query verified");
    expect(inventoryCoverageValue("covered", 0)).toBe("0");
    expect(inventoryCoverageValue("covered", null)).toBe("Count not established");
    expect(inventoryCoverageValue("not_requested", null)).toBe("Not requested");
    expect(inventoryCoverageValue("not_authorized_scope", null)).toBe("Not queried (role scope)");
    expect(inventoryCoverageValue("unknown", null)).toBe("Unknown (not verified)");
    expect(inventoryCoverageValue("unknown", 0)).toBe("0 observed; completeness not verified");
  });

  it("identifies an invalid saved timestamp explicitly", () => {
    expect(savedInventoryTime("invalid")).toBe("Invalid saved timestamp");
  });
});
