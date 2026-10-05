import { describe, expect, it } from "vitest";
import { inventoryCoverageLabel, inventoryRequestScope, inventoryRoleHint, savedInventoryTime } from "./inventoryVerification";

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

  it("labels every coverage state without promoting an unverified query to complete coverage", () => {
    expect(inventoryCoverageLabel("covered")).toBe("Authorized query verified");
    expect(inventoryCoverageLabel("not_requested")).toBe("Not requested");
    expect(inventoryCoverageLabel("not_authorized_scope")).toBe("Not queried (role scope)");
    expect(inventoryCoverageLabel("unknown")).toBe("Unknown (not verified)");
  });

  it("identifies an invalid saved timestamp explicitly", () => {
    expect(savedInventoryTime("invalid")).toBe("Invalid saved timestamp");
  });
});
