import { describe, expect, it } from "vitest";
import { unifiedAgentInventoryQuery } from "./unifiedAgents.js";
import { parseUnifiedAgentRecordId, unifiedAgentRecordId } from "../types/unifiedAgents.js";

describe("unified agent inventory query", () => {
  it("parses typed filters, sorting and pagination", () => {
    expect(unifiedAgentInventoryQuery({
      search: " agent ",
      recordId: "graph_packages:package-a",
      operationIdPrefix: "a5331a93",
      source: "both",
      linkState: "matched",
      environmentId: " environment-a ",
      blocked: "true",
      publisher: "Publisher",
      availableTo: "available:some",
      host: "Teams",
      platform: "Copilot Studio",
      createdWithinDays: "30",
      sortBy: "lastModifiedAt",
      sortDirection: "desc",
      limit: "25",
      offset: "50",
    })).toEqual({
      search: "agent",
      recordId: "graph_packages:package-a",
      operationIdPrefix: "a5331a93",
      source: "both",
      linkState: "matched",
      environmentId: "environment-a",
      blocked: true,
      publisher: "Publisher",
      availableTo: "available:some",
      host: "Teams",
      platform: "Copilot Studio",
      createdWithinDays: 30,
      sortBy: "lastModifiedAt",
      sortDirection: "desc",
      limit: 25,
      offset: 50,
    });
  });

  it("round-trips source-qualified identities and rejects malformed deep links", () => {
    const target = { source: "power_platform" as const, environmentId: "environment-a", nativeId: "native:with/slash%value" };
    const id = unifiedAgentRecordId(target);
    expect(parseUnifiedAgentRecordId(id)).toEqual(target);
    expect(unifiedAgentInventoryQuery({ recordId: id }).recordId).toBe(id);
    for (const recordId of ["unqualified-id", "power_platform:missing-environment", "power_platform:env:%ZZ", "graph_packages:"]) {
      expect(() => unifiedAgentInventoryQuery({ recordId })).toThrowError(expect.objectContaining({ code: "invalid_agent_inventory_query" }));
    }
  });

  it("defaults to a bounded delegated saved read contract and rejects invalid filters", () => {
    expect(unifiedAgentInventoryQuery({})).toMatchObject({
      source: "all",
      sortBy: "displayName",
      sortDirection: "asc",
      limit: 50,
      offset: 0,
    });
    expect(() => unifiedAgentInventoryQuery({ source: "application" })).toThrowError(expect.objectContaining({
      code: "invalid_agent_inventory_query",
    }));
    expect(() => unifiedAgentInventoryQuery({ limit: "251" })).toThrowError(expect.objectContaining({
      code: "invalid_agent_inventory_query",
    }));
    expect(() => unifiedAgentInventoryQuery({ blocked: "all" })).toThrowError(expect.objectContaining({
      code: "invalid_agent_inventory_query",
    }));
    expect(() => unifiedAgentInventoryQuery({ createdWithinDays: "0" })).toThrowError(expect.objectContaining({
      code: "invalid_agent_inventory_query",
    }));
    expect(() => unifiedAgentInventoryQuery({ operationIdPrefix: "invalid%prefix" })).toThrowError(expect.objectContaining({
      code: "invalid_agent_inventory_query",
    }));
  });
});
