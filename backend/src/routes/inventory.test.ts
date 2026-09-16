import { describe, expect, it } from "vitest";
import { inventoryListQuery } from "./inventory.js";

describe("Power Platform inventory list query", () => {
  it("parses server-side agent exclusion for list and export reads", () => {
    expect(inventoryListQuery({ excludeAgents: "true", limit: "25", offset: "50" })).toMatchObject({
      excludeAgents: true,
      limit: 25,
      offset: 50,
    });
    expect(inventoryListQuery({ excludeAgents: "false" }).excludeAgents).toBe(false);
    expect(inventoryListQuery({}).excludeAgents).toBe(false);
  });

  it("rejects non-boolean exclusion values", () => {
    expect(() => inventoryListQuery({ excludeAgents: "1" })).toThrowError(expect.objectContaining({
      code: "invalid_inventory_query",
    }));
  });
});
