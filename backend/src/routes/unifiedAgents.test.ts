import { describe, expect, it } from "vitest";
import { unifiedAgentExportInput, unifiedAgentInventoryQuery } from "./unifiedAgents.js";
import { parseUnifiedAgentRecordId, unifiedAgentRecordId } from "../types/unifiedAgents.js";

describe("unified agent inventory query", () => {
  it("accepts organizational and usage views and new column sorting for list and export", () => {
    expect(unifiedAgentInventoryQuery({ view: "organization", sortBy: "deployment" })).toMatchObject({ view: "organization", sortBy: "deployment" });
    expect(unifiedAgentExportInput({ revision: "a".repeat(64), query: { view: "used", sortBy: "responses", sortDirection: "desc" } }).query)
      .toMatchObject({ view: "used", sortBy: "responses", sortDirection: "desc" });
    expect(() => unifiedAgentInventoryQuery({ view: "active-guessed" })).toThrow();
    expect(() => unifiedAgentInventoryQuery({ sortBy: "actions" })).toThrow();
  });

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

  it("accepts canonical agent UUIDs while rejecting malformed or unscoped canonical links", () => {
    const agentId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    const target = { source: "canonical" as const, agentId: agentId.toLowerCase() };
    expect(parseUnifiedAgentRecordId(`agent:${agentId}`)).toEqual(target);
    expect(unifiedAgentRecordId(target)).toBe(`agent:${agentId.toLowerCase()}`);
    expect(unifiedAgentInventoryQuery({ recordId: `agent:${agentId}` }).recordId).toBe(`agent:${agentId.toLowerCase()}`);
    for (const recordId of ["agent:", "agent:name", `agent:${agentId}:package`, `agent:${agentId}\n`]) {
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

  it("parses typed unified export filters without accepting pagination or provider-specific selection", () => {
    expect(unifiedAgentExportInput({
      revision: "A".repeat(64), query: { environmentId: "environment-a", blocked: false, createdWithinDays: 30, sortDirection: "desc" },
    })).toMatchObject({
      revision: "a".repeat(64), query: { environmentId: "environment-a", blocked: false, createdWithinDays: 30, sortDirection: "desc" },
    });
    for (const input of [
      {}, { revision: "invalid" }, { revision: "a".repeat(64), query: [] },
      { revision: "a".repeat(64), query: { limit: 1 } }, { revision: "a".repeat(64), query: { offset: 1 } },
      { revision: "a".repeat(64), query: { environmentId: 123 } },
      { revision: "a".repeat(64), query: { blocked: {} } }, { revision: "a".repeat(64), source: "graph_packages" },
    ]) expect(() => unifiedAgentExportInput(input)).toThrow();
  });

  it("accepts exact canonical/source aliases and rejects ambiguous export selection intent", () => {
    const canonical = "agent:AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    expect(unifiedAgentExportInput({
      revision: "a".repeat(64), recordIds: [canonical, canonical.toLowerCase(), "graph_packages:opaque%2Fid"],
      query: { sortBy: "displayName", sortDirection: "desc" },
    })).toMatchObject({ recordIds: [canonical.toLowerCase(), "graph_packages:opaque%2Fid"] });
    for (const recordIds of [[], null, [1], ["unqualified"], ["graph_packages:"], Array.from({ length: 5_001 }, () => canonical)]) {
      expect(() => unifiedAgentExportInput({ revision: "a".repeat(64), recordIds })).toThrow();
    }
    expect(() => unifiedAgentExportInput({
      revision: "a".repeat(64), recordIds: [canonical], query: { environmentId: "environment-a" },
    })).toThrowError(expect.objectContaining({ code: "invalid_export_selection" }));
  });
});
