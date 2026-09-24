import { describe, expect, it } from "vitest";
import { huntingAgentRecordId } from "./defenderHunting.js";
import { agentPurviewQuery } from "./unifiedAgents.js";

const recordId = "agent:11111111-1111-4111-8111-111111111111";

describe("agent investigation request contracts", () => {
  it("supports query/body context across the lifecycle, rejecting ambiguous references", () => {
    expect(huntingAgentRecordId({ query: {}, body: {} })).toBeUndefined();
    expect(huntingAgentRecordId({ query: { agentRecordId: recordId }, body: undefined })).toBe(recordId);
    expect(huntingAgentRecordId({ query: {}, body: { agentRecordId: recordId } })).toBe(recordId);
    expect(huntingAgentRecordId({ query: { agentRecordId: recordId }, body: { agentRecordId: recordId } })).toBe(recordId);
    for (const input of [
      { query: { agentRecordId: [recordId, recordId] }, body: {} },
      { query: { agentRecordId: recordId }, body: { agentRecordId: "graph_packages:other" } },
      { query: {}, body: { agentRecordId: null } }, { query: { agentRecordId: "" }, body: {} },
    ]) expect(() => huntingAgentRecordId(input)).toThrow();
  });

  it("bounds saved-only Purview paging and denies bot/environment/tenant overrides", () => {
    expect(agentPurviewQuery({ recordId, limit: "25", offset: "50", search: "  actor  " }))
      .toEqual({ recordId, query: { limit: 25, offset: 50, search: "actor" } });
    expect(agentPurviewQuery({ recordId, search: "x".repeat(256), operation: "BotCreate" }).query)
      .toMatchObject({ search: "x".repeat(256), operation: "BotCreate" });
    for (const extra of [
      { botId: "bot" }, { environmentId: "environment" }, { tenantId: "other" }, { principalId: "other" },
      { limit: "101" }, { limit: "0" }, { offset: "-1" }, { offset: "100001" }, { search: [] }, { search: "x".repeat(257) },
      { operation: "CopilotInteraction" }, { operation: ["BotCreate"] }, { operation: "x".repeat(129) },
    ]) expect(() => agentPurviewQuery({ recordId, ...extra })).toThrow();
  });
});
