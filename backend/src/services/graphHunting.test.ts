import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import type { DefenderHuntingFilters, DefenderHuntingTemplateId } from "../types/defenderHunting.js";
import { GraphHuntingClient, createHuntingRequest, expectedHuntingSchema, validateDefenderHuntingFilters } from "./graphHunting.js";

type SemanticResult = {
  diagnostics: Array<{ code: string; severity: string; message: string; start: number; length: number }>;
  columns: Array<{ name: string; type: string }>;
};

const { compileKusto } = createRequire(import.meta.url)("../../scripts/kusto-semantic.cjs") as {
  compileKusto: (query: string, tables?: Array<{ name: string; schema: string }>) => SemanticResult;
};

const now = new Date("2026-09-09T12:00:00.000Z");
const tenantId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const blueprintId = "33333333-3333-4333-8333-333333333333";

const publishedHuntingTables = [
  {
    name: "AgentsInfo",
    schema: "(Timestamp:datetime, AgentId:string, AgentName:string, Platform:string, AgentDescription:string, Version:string, SourceAgentId:string, EntraAgentId:string, EntraBlueprintId:string, ObservabilityId:dynamic, PublishedStatus:string, LifecycleStatus:string, Availability:string, CreatedDateTime:datetime, LastPublishedDateTime:datetime, LastUpdatedDateTime:datetime, InstanceCount:int, Model:string, Owners:dynamic, SharedWith:dynamic, Permissions:dynamic, ToolsAuthenticationType:dynamic)",
  },
  {
    name: "CloudAppEvents",
    schema: "(Timestamp:datetime, ActionType:string, Application:string, ApplicationId:int, AppInstanceId:int, AccountObjectId:string, AccountId:string, ObjectId:string, ReportId:string, OAuthAppId:string, RawEventData:dynamic)",
  },
];

const publishedProjectionColumns: Record<DefenderHuntingTemplateId, readonly string[]> = {
  agents_inventory: [
    "ObservationTime", "AgentId", "AgentName", "Platform", "AgentDescription", "Version", "SourceAgentId",
    "EntraAgentId", "EntraBlueprintId", "ObservabilityId", "PublishedStatus", "LifecycleStatus", "Availability",
    "CreatedDateTime", "LastPublishedDateTime", "LastUpdatedDateTime", "InstanceCount", "Model", "OwnerCount",
    "SharedWithCount", "PermissionMetadataKeyCount", "AuthenticationMetadataKeyCount", "OwnersState", "SharedWithState",
    "PermissionsState", "AuthenticationState", "RiskState", "ProjectionValid",
  ],
  agent_activity: [
    "Timestamp", "ActionType", "Application", "ApplicationId", "AppInstanceId", "AccountObjectId", "AccountId",
    "ObjectId", "ReportId", "OAuthAppId", "Operation", "OrganizationId", "TargetAgentId", "TargetAgentName",
    "TargetAgentBlueprintId", "AgentId", "AgentName", "AgentBlueprintId", "PlatformTargetAgentId", "ConversationId",
    "PlatformAgentType", "ThreadId", "SessionIdentity", "ChannelName", "HumanUserKey", "HumanUserId", "AgentUserKey",
    "AgentUserId", "TargetAgentUserKey", "OpId", "ParentId", "CreationTime", "CompletionTime", "ErrorType", "ToolName",
    "ToolType", "ToolId", "InvokeSource", "ProjectionValid", "ConversationIdState", "ThreadIdState", "ChannelNameState",
    "HumanUserKeyState", "AgentUserKeyState", "TargetAgentUserKeyState", "CompletionTimeState", "ErrorTypeState",
    "PlatformAgentIdState", "PlatformAgentTypeState",
  ],
  agent_tools: [
    "Timestamp", "ActionType", "Application", "ApplicationId", "AppInstanceId", "AccountObjectId", "AccountId",
    "ObjectId", "ReportId", "OAuthAppId", "Operation", "OrganizationId", "TargetAgentId", "TargetAgentName",
    "TargetAgentBlueprintId", "AgentId", "AgentName", "AgentBlueprintId", "PlatformTargetAgentId", "ConversationId",
    "PlatformAgentType", "ThreadId", "SessionIdentity", "ChannelName", "HumanUserKey", "HumanUserId", "AgentUserKey",
    "AgentUserId", "TargetAgentUserKey", "OpId", "ParentId", "CreationTime", "CompletionTime", "ErrorType", "ToolName",
    "ToolType", "ToolId", "InvokeSource", "ProjectionValid", "ConversationIdState", "ThreadIdState", "ChannelNameState",
    "HumanUserKeyState", "AgentUserKeyState", "TargetAgentUserKeyState", "CompletionTimeState", "ErrorTypeState",
    "PlatformAgentIdState", "PlatformAgentTypeState",
  ],
};

function filters(templateId: DefenderHuntingTemplateId = "agent_activity"): DefenderHuntingFilters {
  return {
    templateId,
    startDateTime: "2026-09-09T11:00:00.000Z",
    endDateTime: "2026-09-09T12:00:00.000Z",
    agentIds: [],
    blueprintIds: [],
    actorObjectIds: [],
    operations: templateId === "agent_activity" ? ["InferenceCall", "InvokeAgent"] : templateId === "agent_tools" ? ["ExecuteToolBySDK"] : [],
  };
}

function response(templateId: DefenderHuntingTemplateId, results: unknown[], status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify({ schema: expectedHuntingSchema(templateId), results }), { status, headers });
}

function row(templateId: DefenderHuntingTemplateId, overrides: Record<string, unknown> = {}) {
  const values = Object.fromEntries(expectedHuntingSchema(templateId).map(({ name }) => [name, ""]));
  return templateId === "agents_inventory"
    ? { ...values, ObservationTime: "2026-09-09T11:30:00.000Z", AgentId: agentId, AgentName: "Bounded agent", Platform: "CopilotStudio", EntraAgentId: agentId, EntraBlueprintId: blueprintId, PublishedStatus: "Published", LifecycleStatus: "Active", InstanceCount: "1", OwnerCount: "2", PermissionMetadataKeyCount: "3", OwnersState: "present_unqualified_shape", SharedWithState: "empty", PermissionsState: "present_unqualified_shape", AuthenticationState: "not_supplied", RiskState: "not_exposed", ProjectionValid: "true", ...overrides }
    : { ...values, Timestamp: "2026-09-09T11:30:00.000Z", ActionType: "InvokeAgent", ApplicationId: "20893", AppInstanceId: "1", AccountObjectId: agentId, OAuthAppId: blueprintId, Operation: "invoke_agent", OrganizationId: tenantId, TargetAgentId: agentId, TargetAgentBlueprintId: blueprintId, OpId: "0123456789abcdef", CreationTime: "2026-09-09T11:30:00.000Z", CompletionTime: "2026-09-09T11:30:01.000Z",
      ProjectionValid: "true",
      ConversationIdState: "empty", ThreadIdState: "unavailable", ChannelNameState: "empty", HumanUserKeyState: "empty", AgentUserKeyState: "unavailable",
      TargetAgentUserKeyState: "empty", CompletionTimeState: "value", ErrorTypeState: "empty", PlatformAgentIdState: "empty", PlatformAgentTypeState: "empty", ...overrides };
}

describe("Microsoft Graph v1.0 curated hunting contract", () => {
  it("semantically compiles every generated template against independent published table schemas", () => {
    const literalAgentIds = ["agent\\name", "agent'one", "agent\\'); union CloudAppEvents //"];
    for (const templateId of ["agents_inventory", "agent_activity", "agent_tools"] as const) {
      const query = createHuntingRequest({
        ...filters(templateId),
        agentIds: literalAgentIds,
        blueprintIds: [blueprintId],
        actorObjectIds: templateId === "agents_inventory" ? [] : [agentId],
      }).Query;
      const compiled = compileKusto(query, publishedHuntingTables);
      expect(compiled.diagnostics, `${templateId}: ${JSON.stringify(compiled.diagnostics)}`).toEqual([]);
      expect(compiled.columns).toEqual(publishedProjectionColumns[templateId].map(name => ({ name, type: "string" })));
      expect(expectedHuntingSchema(templateId)).toEqual(publishedProjectionColumns[templateId].map(name => ({ name, type: "String" })));
      expect(query).toContain("@'agent''one'");
      expect(query).toContain("@'agent\\name'");
      expect(query.match(/format_datetime\([^\n]+?'yyyy-MM-ddTHH:mm:ss\.fffZ'\)/g)?.length).toBe(4);
      const firstExactPredicate = query.indexOf(templateId === "agents_inventory" ? "| where AgentId in" : "| where ActionType in");
      expect(firstExactPredicate).toBeGreaterThan(0);
      expect(firstExactPredicate).toBeLessThan(query.indexOf("| extend Timestamp=iff(ProjectionValid"));
    }

    const scalarApi = compileKusto(`print StringType=gettype("value"), IntegerType=gettype(int(1)), LongType=gettype(long(1)), RealType=gettype(real(1)), DecimalType=gettype(decimal(1)), DatetimeType=gettype(datetime(2026-09-09)), GuidType=gettype(guid(11111111-1111-4111-8111-111111111111)), BooleanType=gettype(true), DictionaryAllowed=gettype(dynamic({"key":"value"}))=="dictionary", ArrayAllowed=gettype(dynamic([1]))=="array"`);
    expect(scalarApi.diagnostics).toEqual([]);
    expect(scalarApi.columns).toEqual([
      "StringType", "IntegerType", "LongType", "RealType", "DecimalType", "DatetimeType", "GuidType", "BooleanType",
    ].map(name => ({ name, type: "string" })).concat([
      { name: "DictionaryAllowed", type: "bool" }, { name: "ArrayAllowed", type: "bool" },
    ]));
  });

  it("accepts Kusto's empty string representation of a source null while retaining its state", async () => {
    const client = new GraphHuntingClient({ fetch: vi.fn(async () => response("agent_activity", [row("agent_activity", {
      ConversationId: "", ConversationIdState: "null",
    })])) as typeof fetch, wait: vi.fn(), random: () => 0 });
    await expect(client.runQuery("token", filters())).resolves.toMatchObject({ rows: [{
      conversationId: null, fieldStates: { conversationId: "null" },
    }] });
  });

  it("uses the action-specific alternate platform identity in the filter as well as projection", () => {
    const query = createHuntingRequest({ ...filters("agent_tools"), agentIds: ["native-tool-agent"] }).Query;
    expect(query).toContain('iff(ActionType=="InvokeAgent",tostring(Event.PlatformTargetAgentId),tostring(Event.PlatformAgentId)) in (@\'native-tool-agent\')');
  });

  it("builds only a code-owned Query and bounded Timespan without workspace selection", () => {
    const value = createHuntingRequest({ ...filters("agent_activity"), agentIds: ["agent'one"], operations: ["InvokeAgent"] });
    expect(Object.keys(value)).toEqual(["Query", "Timespan"]);
    expect(value).not.toHaveProperty("workspaceId");
    expect(value.Timespan).toBe("2026-09-09T11:00:00.000Z/2026-09-09T12:00:00.000Z");
    expect(value.Query).toContain("| where Timestamp between (datetime(2026-09-09T11:00:00.000Z) .. datetime(2026-09-09T12:00:00.000Z))");
    expect(value.Query).toContain("Timestamp=format_datetime(Timestamp, 'yyyy-MM-ddTHH:mm:ss.fffZ')");
    expect(value.Query).toContain("ActionType in (@'InvokeAgent')");
    expect(value.Query).toContain("@'agent''one'");
    expect(value.Query).toContain("parse_json(tostring(RawEventData))");
    expect(value.Query).toContain('gettype(Event)=="dictionary"');
    expect(value.Query).toContain('gettype(CopilotEventData)=="dictionary"');
    expect(value.Query).toContain("Event=iff(ProjectionValid,Event,dynamic(null))");
    expect(value.Query).toContain("ProjectionValid=tostring(ProjectionValid)");
    expect(value.Query).not.toContain("gen_ai.input.messages");
    expect(value.Query).not.toContain("gen_ai.output.messages");
  });

  it("preserves quotes and backslashes as verbatim filter values, never query syntax", () => {
    const agentIds = ["agent\\name", "agent'one", "agent\\'); union CloudAppEvents //"];
    const validated = validateDefenderHuntingFilters({ ...filters("agents_inventory"), agentIds }, { now });
    const query = createHuntingRequest(validated).Query;
    expect(query).toContain("| where AgentId in (@'agent''one',@'agent\\''); union CloudAppEvents //',@'agent\\name')");
  });

  it("validates fixed templates, operations, typed actor IDs, range, and rejects arbitrary fields", () => {
    expect(validateDefenderHuntingFilters(filters(), { now })).toEqual(filters());
    expect(() => validateDefenderHuntingFilters({ ...filters(), Query: "CloudAppEvents" }, { now })).toThrowError(expect.objectContaining({ code: "invalid_hunting_filters" }));
    expect(() => validateDefenderHuntingFilters({ ...filters(), operations: ["DeleteEverything"] }, { now })).toThrowError(expect.objectContaining({ code: "invalid_hunting_filters" }));
    expect(() => validateDefenderHuntingFilters({ ...filters(), actorObjectIds: ["not-an-object-id"] }, { now })).toThrowError(expect.objectContaining({ code: "invalid_hunting_filters" }));
    expect(() => validateDefenderHuntingFilters({ ...filters(), startDateTime: "2026-09-01T00:00:00.000Z" }, { now })).toThrowError(expect.objectContaining({ code: "invalid_hunting_range" }));
    expect(() => validateDefenderHuntingFilters(filters("agents_inventory"), { now, qualification: true })).not.toThrow();
  });

  it("posts the exact Graph endpoint with correlation headers and accepts an empty success as no rows", async () => {
    const fetcher = vi.fn(async () => response("agent_activity", [], 200, { "request-id": "provider-request" }));
    const onResponse = vi.fn(async () => undefined);
    const client = new GraphHuntingClient({ fetch: fetcher as typeof fetch, wait: vi.fn(), random: () => 0 });
    await expect(client.runQuery("token", filters(), { correlationId: "local-request", onResponse })).resolves.toMatchObject({ rows: [], complete: true, providerRowCount: 0 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://graph.microsoft.com/v1.0/security/runHuntingQuery");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "POST", redirect: "manual", headers: expect.objectContaining({ "client-request-id": "local-request" }) });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual(createHuntingRequest(filters()));
    expect(onResponse).toHaveBeenCalledWith("provider-request");
  });

  it("projects current AgentsInfo identifiers while retaining only counts for undocumented dynamic shapes", async () => {
    const client = new GraphHuntingClient({ fetch: vi.fn(async () => response("agents_inventory", [row("agents_inventory")])) as typeof fetch, wait: vi.fn(), random: () => 0 });
    await expect(client.runQuery("token", filters("agents_inventory"))).resolves.toMatchObject({ rows: [{ projectionVersion: 3, sourceTable: "AgentsInfo", agentId, entraAgentObjectId: agentId, entraBlueprintId: blueprintId, ownerCount: 2, permissionMetadataKeyCount: 3,
      detailStates: { owners: "present_unqualified_shape", sharing: "empty", permissions: "present_unqualified_shape", authentication: "not_supplied", risk: "not_exposed" } }] });
    const query = createHuntingRequest(filters("agents_inventory")).Query;
    expect(query).toContain("AgentsInfo");
    expect(query).not.toContain("AIAgentsInfo");
    expect(query).not.toMatch(/Instructions|Memory|RawAgentInfo|DeclaredTools|McpServers/);
    expect(query).not.toContain("AgentId=substring");
    expect(query).toContain("RiskState=\"not_exposed\"");
    expect(query).toContain("AgentId=iff(ProjectionValid,AgentId,dynamic(null))");
  });

  it("retains documented CloudAppEvents metadata but no content, arguments, results, model, or token counts", async () => {
    const client = new GraphHuntingClient({ fetch: vi.fn(async () => response("agent_activity", [row("agent_activity")])) as typeof fetch, wait: vi.fn(), random: () => 0 });
    await expect(client.runQuery("token", filters())).resolves.toMatchObject({ rows: [{ sourceTable: "CloudAppEvents", actionType: "InvokeAgent", organizationId: tenantId, targetAgentId: agentId, spanId: "0123456789abcdef", contentAvailable: false }] });
    const query = createHuntingRequest(filters()).Query;
    expect(query).not.toMatch(/InputMessages|OutputMessages|ToolArguments|ToolResult|RequestModel|InputTokens|OutputTokens/);
    expect(query).not.toMatch(/project[^\n]*RawEventData/);
  });

  it("uses the official IA/ET/CH paths and preserves actor, agent-account, thread, duration, and root-span truth", async () => {
    const query = createHuntingRequest(filters()).Query;
    expect(query).toContain("CopilotEventData=parse_json(tostring(Event.CopilotEventData))");
    expect(query).toContain("tostring(Event.PlatformAgentId)");
    expect(query).toContain("tostring(CopilotEventData.ConversationId)");
    expect(query).toContain("tostring(CopilotEventData.ThreadId)");
    expect(query).toContain("todatetime(CopilotEventData.CompletionTime)");
    expect(query).toContain("tostring(CopilotEventData.ErrorType)");
    expect(query).toContain("ConversationIdState=case(");
    expect(query).toContain("ThreadIdState=iff(");

    const chatRow = row("agent_activity", { ActionType: "InferenceCall", Operation: "chat", ConversationId: "conversation-a", ThreadId: "",
      AgentUserKey: agentId, AgentUserId: "agent@example.invalid", PlatformTargetAgentId: "platform-agent", PlatformAgentType: "partner-system",
      CreationTime: "2026-09-09T11:30:00.000Z", CompletionTime: "2026-09-09T11:30:01.250Z", ErrorType: null, ParentId: "fedcba9876543210",
      ConversationIdState: "value", ThreadIdState: "empty", ChannelNameState: "unavailable", HumanUserKeyState: "unavailable", AgentUserKeyState: "value",
      TargetAgentUserKeyState: "unavailable", CompletionTimeState: "value", ErrorTypeState: "null", PlatformAgentIdState: "value", PlatformAgentTypeState: "value" });
    const client = new GraphHuntingClient({ fetch: vi.fn(async () => response("agent_activity", [chatRow])) as typeof fetch, wait: vi.fn(), random: () => 0 });
    await expect(client.runQuery("token", filters(), { tenantId })).resolves.toMatchObject({ rows: [{ projectionVersion: 3, operation: "chat",
      conversationId: "conversation-a", conversationThreadId: null, agentUserObjectId: agentId, humanActorUserObjectId: null,
      durationMilliseconds: 1250, outcome: "unknown", spanRole: "child", rootSpanObserved: false,
      fieldStates: { conversationId: "value", conversationThreadId: "empty", channelName: "unavailable", humanActorUserObjectId: "unavailable",
        agentUserObjectId: "value", targetAgentUserObjectId: "unavailable", errorType: "null" } }] });
  });

  it("rejects activity field-state claims that disagree with their projected value", async () => {
    const invalid = row("agent_activity", { ConversationId: null, ConversationIdState: "value" });
    const client = new GraphHuntingClient({ fetch: vi.fn(async () => response("agent_activity", [invalid])) as typeof fetch, wait: vi.fn(), random: () => 0 });
    await expect(client.runQuery("token", filters())).rejects.toMatchObject({ code: "provider_schema" });
  });

  it("rejects oversized exact identifiers instead of silently truncating them", async () => {
    const client = new GraphHuntingClient({ fetch: vi.fn(async () => response("agents_inventory", [row("agents_inventory", { AgentId: "a".repeat(513) })])) as typeof fetch, wait: vi.fn(), random: () => 0 });
    await expect(client.runQuery("token", filters("agents_inventory"))).rejects.toMatchObject({ code: "provider_schema" });
  });

  it("rejects activity rows outside the requested tenant, operations, or UTC interval", async () => {
    const scopedOptions = { tenantId } as Parameters<GraphHuntingClient["runQuery"]>[2] & { tenantId: string };
    for (const invalidRow of [
      row("agent_activity", { OrganizationId: "44444444-4444-4444-8444-444444444444" }),
      row("agent_activity", { ActionType: "InferenceCall", Operation: "execute_tool" }),
      row("agent_activity", { Timestamp: "2026-09-09T10:59:59.999Z" }),
    ]) {
      const client = new GraphHuntingClient({ fetch: vi.fn(async () => response("agent_activity", [invalidRow])) as typeof fetch, wait: vi.fn(), random: () => 0 });
      await expect(client.runQuery("token", { ...filters(), operations: ["InvokeAgent"] }, scopedOptions)).rejects.toMatchObject({ code: "provider_scope_mismatch" });
    }
  });

  it("requires exact lower-case schema wrappers and exact projected row casing", async () => {
    const wrongSchema = { schema: expectedHuntingSchema("agent_activity").map(entry => ({ Name: entry.name, Type: entry.type })), results: [] };
    const schemaClient = new GraphHuntingClient({ fetch: vi.fn(async () => new Response(JSON.stringify(wrongSchema))) as typeof fetch, wait: vi.fn(), random: () => 0 });
    await expect(schemaClient.runQuery("token", filters())).rejects.toMatchObject({ code: "provider_schema" });
    const wrongRow = row("agent_activity");
    delete wrongRow.Timestamp;
    wrongRow.timestamp = "2026-09-09T11:30:00.000Z";
    const rowClient = new GraphHuntingClient({ fetch: vi.fn(async () => response("agent_activity", [wrongRow])) as typeof fetch, wait: vi.fn(), random: () => 0 });
    await expect(rowClient.runQuery("token", filters())).rejects.toMatchObject({ code: "provider_schema" });
  });

  it("rejects malformed dynamic projections instead of retaining provider wrappers", async () => {
    const client = new GraphHuntingClient({ fetch: vi.fn(async () => response("agent_activity", [row("agent_activity", { TargetAgentId: { secret: "discard" } })])) as typeof fetch, wait: vi.fn(), random: () => 0 });
    await expect(client.runQuery("token", filters())).rejects.toMatchObject({ code: "provider_schema" });
  });

  it("rejects the value-free projected-wire signal for malformed wrappers or selected scalar dynamics", async () => {
    for (const projected of [
      row("agent_activity", { ProjectionValid: "false", TargetAgentId: "", ConversationId: "", ConversationIdState: "unavailable" }),
      row("agent_activity", { ProjectionValid: "false", AgentId: "", PlatformTargetAgentId: "", PlatformAgentIdState: "unavailable" }),
    ]) {
      const client = new GraphHuntingClient({ fetch: vi.fn(async () => response("agent_activity", [projected])) as typeof fetch, wait: vi.fn(), random: () => 0 });
      await expect(client.runQuery("token", filters())).rejects.toMatchObject({ code: "provider_schema" });
    }
    expect(JSON.stringify(expectedHuntingSchema("agent_activity"))).not.toMatch(/RawEventData|CopilotEventData|secret/i);
  });

  it("requires exact millisecond UTC projected dates and does not infer a root without a valid span", async () => {
    for (const invalidDate of ["2026-09-09T11:30:00Z", "2026-09-09T13:30:00.000+02:00", "2026-09-09 11:30:00.000Z"]) {
      const client = new GraphHuntingClient({ fetch: vi.fn(async () => response("agent_activity", [row("agent_activity", { CompletionTime: invalidDate })])) as typeof fetch, wait: vi.fn(), random: () => 0 });
      await expect(client.runQuery("token", filters())).rejects.toMatchObject({ code: "provider_schema" });
    }

    const missingRootEvidence = row("agent_activity", { OpId: "", ParentId: "", ConversationId: "", ConversationIdState: "null" });
    const client = new GraphHuntingClient({ fetch: vi.fn(async () => response("agent_activity", [missingRootEvidence])) as typeof fetch, wait: vi.fn(), random: () => 0 });
    await expect(client.runQuery("token", filters())).resolves.toMatchObject({ rows: [{ spanId: null, parentSpanId: null,
      conversationId: null, spanRole: "unresolved", rootSpanObserved: false }] });

    const observed = new GraphHuntingClient({ fetch: vi.fn(async () => response("agent_activity", [row("agent_activity")])) as typeof fetch, wait: vi.fn(), random: () => 0 });
    await expect(observed.runQuery("token", filters())).resolves.toMatchObject({ rows: [{ spanId: "0123456789abcdef",
      spanRole: "root_invoke_agent", rootSpanObserved: true }] });
  });

  it("marks a sentinel row as capped and stores only the hard row budget", async () => {
    const rows = Array.from({ length: 201 }, (_, index) => row("agent_activity", { ReportId: `event-${index}` }));
    const client = new GraphHuntingClient({ fetch: vi.fn(async () => response("agent_activity", rows)) as typeof fetch, wait: vi.fn(), random: () => 0 });
    await expect(client.runQuery("token", filters())).resolves.toMatchObject({ providerRowCount: 201, storedRowCount: 200, complete: false, partialReason: "hunting_row_limit" });
  });

  it("retries safe read-query throttling within budget and reports RBAC ambiguity without guessing", async () => {
    const wait = vi.fn(async () => undefined);
    const first = new Response("", { status: 429, headers: { "retry-after": "1", "request-id": "throttled" } });
    const fetcher = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(response("agent_tools", []));
    const client = new GraphHuntingClient({ fetch: fetcher as typeof fetch, wait, random: () => 0, now: () => 0 });
    await expect(client.runQuery("token", filters("agent_tools"))).resolves.toMatchObject({ complete: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(1_000, undefined);

    const denied = new GraphHuntingClient({ fetch: vi.fn(async () => new Response("", { status: 403 })) as typeof fetch, wait: vi.fn(), random: () => 0 });
    await expect(denied.runQuery("token", filters())).rejects.toMatchObject({ code: "hunting_access_denied", status: 403 });
  });

  it("applies the attempt deadline while consuming a stalled response", async () => {
    const cancel = vi.fn(async () => undefined);
    const body = new ReadableStream({ pull: () => new Promise(() => undefined), cancel });
    const client = new GraphHuntingClient({ fetch: vi.fn(async () => new Response(body, { status: 200 })) as typeof fetch, wait: vi.fn(), random: () => 0, requestTimeoutMs: 5 });
    await expect(client.runQuery("token", filters())).rejects.toMatchObject({ code: "provider_error" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("applies the attempt deadline when an injected transport ignores its abort signal", async () => {
    const client = new GraphHuntingClient({ fetch: vi.fn(() => new Promise<Response>(() => undefined)) as typeof fetch,
      wait: vi.fn(), random: () => 0, requestTimeoutMs: 5 });
    await expect(client.runQuery("token", filters())).rejects.toMatchObject({ code: "provider_error" });
  });
});