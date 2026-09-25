import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import type { DefenderHuntingFilters, DefenderHuntingQueryResult } from "../types/defenderHunting.js";
import { GraphHuntingClient, expectedHuntingSchema, validateDefenderHuntingFilters } from "../services/graphHunting.js";
import { DefenderHuntingRepository, type DefenderHuntingScope } from "./defenderHunting.js";

const id = "11111111-1111-4111-8111-111111111111";
const scope: DefenderHuntingScope = { tenantId: "tenant-a", authorizationPrincipalId: "reader",
  resultScope: { kind: "principal", scopeId: "reader", configurationRevision: null }, tokenMode: "delegated" };
const filters: DefenderHuntingFilters = { templateId: "agents_inventory", startDateTime: "2026-09-09T10:00:00.000Z",
  endDateTime: "2026-09-09T11:00:00.000Z", agentIds: [], blueprintIds: [], actorObjectIds: [], operations: [] };
const result: DefenderHuntingQueryResult = { rows: [], providerRowCount: 0, storedRowCount: 0, byteCount: 2, complete: true, partialReason: null };
const execution = { owner: "22222222-2222-4222-8222-222222222222", version: 1 };

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const database = new pg.Pool();
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  vi.spyOn(database, "connect").mockImplementation(async () => client);
  const response = (rows: object[] = []) => ({ command: "", oid: 0, fields: [], rowCount: rows.length, rows });
  const row = { filters, deadline_at: new Date(Date.now() + 60_000), is_qualification: false };
  const query = vi.fn(async (text: unknown) => response(typeof text === "string" && text.includes("FOR UPDATE") ? [row] : []));
  vi.spyOn(client, "query").mockImplementation(query);
  const databaseQuery = vi.spyOn(database, "query").mockResolvedValue(response());
  return { repository: new DefenderHuntingRepository(database), query, databaseQuery, response, row, client };
}

function projectedClient(selected: DefenderHuntingFilters, overrides: Record<string, unknown>, headers: HeadersInit = {}) {
  const defaults = Object.fromEntries(expectedHuntingSchema(selected.templateId).map(({ name }) => [name, ""]));
  const projected = selected.templateId === "agents_inventory" ? {
    ...defaults, ObservationTime: "2026-09-09T10:30:00.000Z", AgentId: "NativeAgent", ProjectionValid: "true",
    OwnersState: "not_supplied", SharedWithState: "not_supplied", PermissionsState: "not_supplied",
    AuthenticationState: "not_supplied", RiskState: "not_exposed", ...overrides,
  } : {
    ...defaults, Timestamp: "2026-09-09T10:30:00.000Z", ActionType: selected.operations[0],
    Operation: selected.templateId === "agent_tools" ? "execute_tool" : "invoke_agent", ProjectionValid: "true",
    ConversationIdState: "null", ThreadIdState: "unavailable", ChannelNameState: "null",
    HumanUserKeyState: selected.templateId === "agent_tools" ? "unavailable" : "null",
    AgentUserKeyState: selected.templateId === "agent_tools" ? "null" : "unavailable",
    TargetAgentUserKeyState: selected.templateId === "agent_tools" ? "unavailable" : "null",
    CompletionTimeState: "null", ErrorTypeState: selected.templateId === "agent_tools" ? "unavailable" : "null",
    PlatformAgentIdState: "null", PlatformAgentTypeState: "null", ...overrides,
  };
  return new GraphHuntingClient({ fetch: vi.fn(async () => new Response(JSON.stringify({
    schema: expectedHuntingSchema(selected.templateId), results: [projected],
  }), { headers })), wait: vi.fn(), random: () => 0 });
}

describe("Defender publication transaction without a database", () => {
  it.each([
    ["agents_inventory", "blueprintIds", "EntraBlueprintId"],
    ["agent_activity", "blueprintIds", "TargetAgentBlueprintId"],
    ["agent_activity", "blueprintIds", "AgentBlueprintId"],
    ["agent_tools", "blueprintIds", "TargetAgentBlueprintId"],
    ["agent_tools", "blueprintIds", "AgentBlueprintId"],
    ["agent_activity", "actorObjectIds", "AccountObjectId"],
    ["agent_tools", "actorObjectIds", "AccountObjectId"],
  ] as const)("publishes adapter-validated %s rows with mixed-case %s matching %s", async (templateId, filter, field) => {
    const mixedId = "ABCDEFAB-1234-4567-8ABC-ABCDEFABCDEF";
    const selected = validateDefenderHuntingFilters({ ...filters, templateId, [filter]: [mixedId],
      operations: templateId === "agents_inventory" ? [] : [templateId === "agent_tools" ? "ExecuteToolBySDK" : "InvokeAgent"],
    }, { now: new Date(filters.endDateTime) });
    const f = fixture();
    f.row.filters = selected;
    const parsed = await projectedClient(selected, { [field]: mixedId }).runQuery("fixture-token", selected);
    await f.repository.publish(scope, id, execution, parsed);
    expect(f.query).toHaveBeenCalledWith("COMMIT");
    expect(f.query).not.toHaveBeenCalledWith("ROLLBACK");
    expect(selected[filter]).toEqual([mixedId]);
  });

  it("does not substitute a human-user alias for the queried account-object actor scope", async () => {
    const actor = "abcdefab-1234-4567-8abc-abcdefabcdef";
    const selected: DefenderHuntingFilters = { ...filters, templateId: "agent_activity", operations: ["InvokeAgent"], actorObjectIds: [actor] };
    const client = projectedClient(selected, { AccountObjectId: id, HumanUserKey: actor, HumanUserKeyState: "value" });
    await expect(client.runQuery("fixture-token", selected)).rejects.toMatchObject({ code: "provider_scope_mismatch" });
    const unscoped = await client.runQuery("fixture-token", { ...selected, actorObjectIds: [] });
    const f = fixture();
    f.row.filters = selected;
    await expect(f.repository.publish(scope, id, execution, unscoped)).rejects.toMatchObject({ code: "invalid_hunting_publication" });
    expect(f.query).toHaveBeenCalledWith("ROLLBACK");
    expect(f.query).not.toHaveBeenCalledWith("COMMIT");
  });

  it.each([256, 257, 512, 513])("records optional request IDs within the repository's bound (%s characters)", async length => {
    const f = fixture();
    f.databaseQuery.mockResolvedValue(f.response([{ id }]));
    const client = projectedClient(filters, {}, { "request-id": "r".repeat(length) });
    const onResponse = vi.fn((requestId: string | null) => f.repository.recordProviderResponse(scope, id, execution, requestId));
    await expect(client.runQuery("fixture-token", filters, { onResponse })).resolves.toMatchObject({ storedRowCount: 1 });
    expect(onResponse).toHaveBeenCalledWith(length <= 256 ? "r".repeat(length) : null);
    expect(f.databaseQuery).toHaveBeenCalledOnce();
  });

  it.each(["locked", "written"] as const)("rolls back when authorization changes after the %s query", async stage => {
    const f = fixture();
    let allowed = true;
    const query = f.query.getMockImplementation()!;
    f.query.mockImplementation(async text => {
      const response = await query(text);
      if (typeof text === "string" && text.includes(stage === "locked" ? "FOR UPDATE" : "UPDATE defender_hunting_jobs SET status")) allowed = false;
      return response;
    });
    const fence = vi.fn(() => { if (!allowed) throw AppError.unauthorized("Session changed."); });
    await expect(f.repository.publish(scope, id, execution, result, fence)).rejects.toMatchObject({ status: 401 });
    expect(f.query).toHaveBeenCalledWith("ROLLBACK");
    expect(f.query).not.toHaveBeenCalledWith("COMMIT");
    expect(fence).toHaveBeenCalledTimes(stage === "locked" ? 1 : 2);
    expect(f.client.release).toHaveBeenCalledOnce();
  });

  it("rolls back if the durable deadline expires during publication writes", async () => {
    const f = fixture();
    const query = f.query.getMockImplementation()!;
    f.query.mockImplementation(async text => {
      const response = await query(text);
      if (typeof text === "string" && text.includes("UPDATE defender_hunting_jobs SET status")) f.row.deadline_at = new Date(0);
      return response;
    });
    await expect(f.repository.publish(scope, id, execution, result)).rejects.toMatchObject({ code: "hunting_job_expired" });
    expect(f.query).toHaveBeenCalledWith("ROLLBACK");
    expect(f.query).not.toHaveBeenCalledWith("COMMIT");
    expect(f.client.release).toHaveBeenCalledOnce();
  });
});
