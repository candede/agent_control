import { describe, expect, it } from "vitest";
import { agentPeopleResolveInput, agentResponsibilityQuery, unifiedAgentInventoryQuery } from "./unifiedAgents.js";
import {
  parseUnifiedAgentRecordId, unifiedAgentRecordId, unifiedAgentInventoryScopes, unifiedAgentSortKeys,
  unifiedAgentViews, unifiedAgentAccessFilters, unifiedAgentUsageFilters, unifiedAgentManagementFilters, unifiedAgentRelevanceFilters,
} from "../types/unifiedAgents.js";
import { decodeInventoryFacet, encodeInventoryFacet, inventoryFacetFields } from "../types/inventoryFacets.js";

const enums = {
  view: unifiedAgentViews, endUserAccess: unifiedAgentAccessFilters, reportedUsage: unifiedAgentUsageFilters,
  management: unifiedAgentManagementFilters, relevance: unifiedAgentRelevanceFilters,
  inventoryScope: unifiedAgentInventoryScopes, sortBy: unifiedAgentSortKeys,
};

describe("selected inventory query protocol", () => {
  it.each(inventoryFacetFields)("preserves exact %s literals and tagged unknowns without sentinel collisions", field => {
    for (const literal of ["all", "__unknown__", "__some_or_all__", "available:all", "~null", "~some-or-all", " firstParty ", "公司🌏", null]) {
      const wire = encodeInventoryFacet(literal);
      expect(decodeInventoryFacet(wire)).toBe(literal);
      expect(unifiedAgentInventoryQuery({ [field]: wire })[field]).toBe(literal);
    }
    expect(unifiedAgentInventoryQuery({})[field]).toBeUndefined();
  });

  it.each(inventoryFacetFields)("rejects malformed or ambiguous %s wire values rather than silently broadening", field => {
    for (const value of ["", " ", "all", "__unknown__", null, 1, true, {}, ["~null"], ["~null", "~string:x"],
      "~string:", "~string:bad\nvalue", "~string:bad\0value", `~string:${"x".repeat(field === "environmentId" ? 513 : 4097)}`]) {
      expect(() => unifiedAgentInventoryQuery({ [field]: value }), JSON.stringify(value))
        .toThrowError(expect.objectContaining({ code: "invalid_agent_inventory_query" }));
    }
    if (field !== "availableTo") expect(() => unifiedAgentInventoryQuery({ [field]: "~some-or-all" })).toThrow();
  });

  it("distinguishes the explicit combined assignment from every provider literal", () => {
    expect(unifiedAgentInventoryQuery({ availableTo: "~some-or-all" }).availableTo).toEqual({ kind: "some-or-all" });
    expect(unifiedAgentInventoryQuery({ availableTo: encodeInventoryFacet("~some-or-all") }).availableTo).toBe("~some-or-all");
  });

  it.each(Object.entries(enums).flatMap(([key, values]) => values.map(value => ({ key, value }))))(
    "accepts exact $key=$value", ({ key, value }) => {
      expect(unifiedAgentInventoryQuery({ [key]: value })).toMatchObject({ [key]: value });
    },
  );

  it.each(Object.keys(enums))("rejects malformed %s enum choices", key => {
    for (const value of ["not-a-choice", " all", "all ", "All", null, true, 1, {}, ["all", "unknown"]]) {
      expect(() => unifiedAgentInventoryQuery({ [key]: value }), JSON.stringify(value)).toThrow();
    }
  });

  it("preserves independent combined filters and bounded selected-page sorting", () => {
    const query = unifiedAgentInventoryQuery({
      search: " agent ", recordId: "graph_packages:package-a", operationIdPrefix: "a5331a93",
      inventoryScope: "catalog", source: "both", linkState: "matched", environmentId: "~string:environment-a",
      blocked: "true", publisher: "~string:Publisher", availableTo: "~some-or-all", host: "~string:Teams",
      platform: "~string:Copilot Studio", createdWithinDays: "30", sortBy: "lastModifiedAt", sortDirection: "desc", limit: "25",
      relevance: "organization", view: "used", endUserAccess: "unavailable", reportedUsage: "used", management: "organization_managed",
    });
    expect(query).toMatchObject({
      search: "agent", recordId: "graph_packages:package-a", operationIdPrefix: "a5331a93",
      inventoryScope: "catalog", source: "both", linkState: "matched", environmentId: "environment-a",
      blocked: true, publisher: "Publisher", availableTo: { kind: "some-or-all" }, host: "Teams", platform: "Copilot Studio",
      createdWithinDays: 30, sortBy: "lastModifiedAt", sortDirection: "desc", limit: 25,
      relevance: "organization", view: "used", endUserAccess: "unavailable", reportedUsage: "used", management: "organization_managed",
    });
    expect(query).not.toHaveProperty("offset");
  });

  it("round-trips exact opaque source identities and canonical UUIDs", () => {
    const target = { source: "power_platform" as const, environmentId: "environment-a", nativeId: "native:with/slash%value" };
    const id = unifiedAgentRecordId(target);
    expect(parseUnifiedAgentRecordId(id)).toEqual(target);
    expect(unifiedAgentInventoryQuery({ recordId: id }).recordId).toBe(id);
    expect(unifiedAgentInventoryQuery({ recordId: "agent:AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }).recordId)
      .toBe("agent:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    for (const recordId of ["unqualified-id", "power_platform:missing-environment", "power_platform:env:%ZZ", "graph_packages:",
      "agent:", "agent:name", "agent:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:package"]) {
      expect(() => unifiedAgentInventoryQuery({ recordId })).toThrow();
    }
  });

  it("requires bounded pages, known boolean/numeric filters, and exact operation references", () => {
    expect(unifiedAgentInventoryQuery({})).toMatchObject({
      inventoryScope: "all", source: "all", sortBy: "displayName", sortDirection: "asc", limit: 50,
    });
    for (const query of [{ source: "application" }, { limit: "101" }, { limit: "0" }, { blocked: "all" },
      { createdWithinDays: "0" }, { operationIdPrefix: "invalid%prefix" }]) {
      expect(() => unifiedAgentInventoryQuery(query)).toThrowError(expect.objectContaining({ code: "invalid_agent_inventory_query" }));
    }
  });

  it("validates exact responsibility identifiers without tenant or name overrides", () => {
    const selectionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    expect(agentResponsibilityQuery({ objectId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", selectionId, cursor: "selected-page", limit: "100" }))
      .toEqual({ objectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", search: undefined, selectionId, cursor: "selected-page", limit: 100 });
    for (const query of [{ objectId: "alice@example.invalid" }, { objectId: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"] },
      { tenantId: "other" }, { principalId: "other" }, { name: "Alice" }, { limit: "101" }, { offset: "-1" },
      { offset: "30001" }, { search: "bad\nname" }, { search: "x".repeat(257) }]) {
      expect(() => agentResponsibilityQuery(query)).toThrow();
    }
  });

  it("accepts only saved record identifiers for persistent people resolution", () => {
    expect(agentPeopleResolveInput({ recordId: "agent:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }))
      .toEqual({ recordId: "agent:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", force: false });
    expect(agentPeopleResolveInput({ recordId: "graph_packages:package", force: true }).force).toBe(true);
    for (const input of [null, [], {}, { recordId: "unqualified" }, { recordId: "graph_packages:package", force: 1 },
      { recordId: "graph_packages:package", principalId: "other" }, { ids: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"] }]) {
      expect(() => agentPeopleResolveInput(input)).toThrow();
    }
  });
});
