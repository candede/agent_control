import { describe, expect, it } from "vitest";
import { inventoryExportQuery } from "./inventory.js";

describe("Power Platform agent export query", () => {
  it("parses only agent export filters and sorting", () => {
    expect(inventoryExportQuery({ environmentId: "environment", search: "Agent", sortBy: "createdAt", sortDirection: "desc" })).toEqual({
      environmentId: "environment", search: "Agent", sortBy: "createdAt", sortDirection: "desc",
    });
    expect(inventoryExportQuery({})).toEqual({
      environmentId: undefined, search: undefined, sortBy: "displayName", sortDirection: "asc",
    });
  });

  it.each([
    { type: "microsoft.powerplatform/environments" }, { type: "microsoft.copilotstudio/agents" },
    { excludeAgents: "true" }, { excludeAgents: "false" }, { limit: "25" }, { offset: "50" },
    { sortBy: "type" }, { environmentId: "invalid\nscope" }, { search: "x".repeat(257) },
  ])("rejects retired catalog filters or invalid agent scope %j", query => {
    expect(() => inventoryExportQuery(query)).toThrowError(expect.objectContaining({ code: "invalid_inventory_query" }));
  });
});
