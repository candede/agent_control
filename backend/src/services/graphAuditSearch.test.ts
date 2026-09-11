import { describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import { GraphAuditSearchClient, createProviderQueryBody, providerQueryMatches, validatePurviewAuditFilters } from "./graphAuditSearch.js";
import type { PurviewAuditFilters, PurviewProviderQuery } from "../types/purviewAudit.js";

const tenantId = "11111111-1111-1111-1111-111111111111";
const marker = "agent-control-audit:22222222-2222-4222-8222-222222222222";
const now = new Date("2026-09-09T12:00:00.000Z");
const filters: PurviewAuditFilters = {
  presetId: "copilot_interactions",
  operations: ["CopilotInteraction"],
  startDateTime: "2026-09-09T11:00:00.000Z",
  endDateTime: "2026-09-09T12:00:00.000Z",
  userPrincipalNames: [], ipAddresses: [], objectIds: [], administrativeUnitIds: [],
};

function query(status: PurviewProviderQuery["status"] = "running"): PurviewProviderQuery {
  return { id: "provider-1", status, ...createProviderQueryBody(marker, filters) };
}

function response(value: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}

function copilotEventData(overrides: Record<string, unknown> = {}) {
  return {
    AgentId: "CopilotStudio.Declarative.44444444-4444-4444-8444-444444444444",
    AppIdentity: "Copilot.Studio.55555555-5555-4555-8555-555555555555",
    AppHost: "Teams",
    Messages: [{ ID: "message-1", isPrompt: true, Content: "discard-me" }],
    ...overrides,
  };
}

function dynamicProperties(overrides: Record<string, unknown> = {}) {
  return {
    "@odata.type": "#microsoft.graph.security.auditRecordTypeDictionary",
    ID: "33333333-3333-4333-8333-333333333333",
    CreationTime: "2026-09-09T11:30:00.000Z",
    Operation: "CopilotInteraction",
    OrganizationId: tenantId,
    RecordType: 261,
    ResultStatus: "Succeeded",
    UserId: "user-1",
    UserKey: "user-key-1",
    UserType: 0,
    Version: 1,
    Workload: "Copilot",
    CorrelationId: "correlation-1",
    CopilotEventData: copilotEventData(),
    PromptText: "discard-me",
    UnknownObject: { secret: "discard-me" },
    ...overrides,
  };
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    "@odata.type": "#microsoft.graph.security.auditLogRecord",
    id: "wrapper-1", createdDateTime: "2026-09-09T11:30:00.000Z", auditLogRecordType: "copilotInteraction", operation: "CopilotInteraction",
    organizationId: tenantId, userType: "regular", userId: "user-1", service: "Copilot", objectId: "object-1", userPrincipalName: "user@example.invalid",
    clientIp: "192.0.2.1", administrativeUnits: [], auditData: {
      "@odata.type": "#microsoft.graph.security.defaultAuditData",
      dynamicProperties: dynamicProperties(),
    }, ...overrides,
  };
}

function recordWithDynamicProperties(overrides: Record<string, unknown>) {
  return record({ auditData: {
    "@odata.type": "#microsoft.graph.security.defaultAuditData",
    dynamicProperties: dynamicProperties(overrides),
  } });
}

function studioRecord() {
  return record({
    id: "wrapper-studio", auditLogRecordType: "powerPlatformAdministratorActivity", operation: "BotCreate",
    userType: "admin", service: "PowerPlatform", objectId: "bot-1",
    auditData: {
      "@odata.type": "#microsoft.graph.security.defaultAuditData",
      dynamicProperties: {
        "@odata.type": "#microsoft.graph.security.auditRecordTypeDictionary",
        ID: "66666666-6666-4666-8666-666666666666", CreationTime: "2026-09-09T11:30:00.000Z",
        Operation: "BotCreate", OrganizationId: tenantId, RecordType: 256, ResultStatus: "Succeeded",
        UserId: "user-1", UserKey: "user-key-1", UserType: 2, Version: 1, Workload: "PowerPlatform",
        BotId: "bot-1", EnvironmentId: "environment-1",
      },
    },
  });
}

describe("Graph Audit Search selected v1.0 contract", () => {
  it("builds only the singular serviceFilter request contract", () => {
    expect(createProviderQueryBody(marker, filters)).toEqual({
      displayName: marker, filterStartDateTime: filters.startDateTime, filterEndDateTime: filters.endDateTime,
      recordTypeFilters: ["copilotInteraction"], serviceFilter: "Copilot", operationFilters: ["CopilotInteraction"],
      userPrincipalNameFilters: [], ipAddressFilters: [], objectIdFilters: [], administrativeUnitIdFilters: [],
    });
    expect(createProviderQueryBody(marker, filters)).not.toHaveProperty("serviceFilters");
    expect(createProviderQueryBody(marker, filters)).not.toHaveProperty("keywordFilter");
  });

  it("creates once and accepts only a direct query object", async () => {
    const fetcher = vi.fn(async () => response(query("notStarted"), 201));
    const client = new GraphAuditSearchClient({ fetch: fetcher as typeof fetch, wait: vi.fn(), random: () => 0 });
    await expect(client.createQuery("token", marker, filters)).resolves.toMatchObject({ id: "provider-1", serviceFilter: "Copilot" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual(createProviderQueryBody(marker, filters));

    const variant = new GraphAuditSearchClient({ fetch: vi.fn(async () => response({ value: query() }, 201)) as typeof fetch, wait: vi.fn(), random: () => 0 });
    await expect(variant.createQuery("token", marker, filters)).rejects.toMatchObject({ code: "provider_schema" });
  });

  it("requires the documented status for each successful response shape", async () => {
    const getClient = new GraphAuditSearchClient({ fetch: vi.fn(async () => response(query(), 201)) as typeof fetch, wait: vi.fn(), random: () => 0 });
    await expect(getClient.getQuery("token", "provider-1")).rejects.toMatchObject({ code: "provider_error" });
    const listClient = new GraphAuditSearchClient({ fetch: vi.fn(async () => response({ value: [] }, 201)) as typeof fetch, wait: vi.fn(), random: () => 0 });
    await expect(listClient.listQueries("token")).rejects.toMatchObject({ code: "provider_error" });
    const recordsClient = new GraphAuditSearchClient({ fetch: vi.fn(async () => response({ value: [] }, 201)) as typeof fetch, wait: vi.fn(), random: () => 0 });
    await expect(recordsClient.listRecords("token", "provider-1", tenantId)).rejects.toMatchObject({ code: "provider_error" });
  });

  it("never retries an ambiguous create and reconciles by exact marker and filters", async () => {
    const fetcher = vi.fn(async () => { throw new TypeError("socket reset"); });
    const client = new GraphAuditSearchClient({ fetch: fetcher as typeof fetch, wait: vi.fn(), random: () => 0 });
    await expect(client.createQuery("token", marker, filters)).rejects.toMatchObject({ code: "audit_create_inconclusive" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(providerQueryMatches(query(), marker, filters)).toBe(true);
    expect(providerQueryMatches({ ...query(), operationFilters: [...query().operationFilters].reverse() }, marker, filters)).toBe(true);
    expect(providerQueryMatches({ ...query(), operationFilters: ["Other"] }, marker, filters)).toBe(false);
  });

  it("treats a failed 201 response stream as an inconclusive create without another POST", async () => {
    const failedStream = new ReadableStream({ start(controller) { controller.error(new TypeError("response reset")); } });
    const fetcher = vi.fn(async () => new Response(failedStream, { status: 201 }));
    const client = new GraphAuditSearchClient({ fetch: fetcher as typeof fetch, wait: vi.fn(), random: () => 0 });
    await expect(client.createQuery("token", marker, filters)).rejects.toMatchObject({ code: "audit_create_inconclusive" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects the documented conflicting GET envelope and plural service shape", async () => {
    const wrapped = new GraphAuditSearchClient({ fetch: vi.fn(async () => response({ value: query() })) as typeof fetch, wait: vi.fn(), random: () => 0 });
    await expect(wrapped.getQuery("token", "provider-1")).rejects.toMatchObject({ code: "provider_schema" });
    const plural = { ...query() } as Record<string, unknown>;
    delete plural.serviceFilter;
    plural.serviceFilters = ["Copilot"];
    const pluralClient = new GraphAuditSearchClient({ fetch: vi.fn(async () => response(plural)) as typeof fetch, wait: vi.fn(), random: () => 0 });
    await expect(pluralClient.getQuery("token", "provider-1")).rejects.toMatchObject({ code: "provider_schema" });
  });

  it("uses numeric and HTTP-date Retry-After only for idempotent reads and cancels retry bodies", async () => {
    const wait = vi.fn(async () => undefined);
    const beforeRequest = vi.fn(async () => undefined);
    const onResponse = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const retryBody = new ReadableStream({ cancel });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(retryBody, { status: 429, headers: { "retry-after": "Wed, 09 Sep 2026 12:00:02 GMT", date: "Wed, 09 Sep 2026 12:00:00 GMT", "request-id": "request-1" } }))
      .mockResolvedValueOnce(response(query("succeeded"), 200, { "request-id": "request-2" }));
    const client = new GraphAuditSearchClient({ fetch: fetcher as typeof fetch, wait, random: () => 0, now: () => 0 });
    await expect(client.getQuery("token", "provider-1", { beforeRequest, onResponse })).resolves.toMatchObject({ status: "succeeded" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(2_000, undefined);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(beforeRequest).toHaveBeenCalledTimes(2);
    expect(onResponse.mock.calls).toEqual([["request-1"], ["request-2"]]);
  });

  it("does not retry when Retry-After would exhaust the request budget", async () => {
    const wait = vi.fn(async () => undefined);
    const fetcher = vi.fn(async () => response({}, 429, { "retry-after": "60" }));
    const client = new GraphAuditSearchClient({ fetch: fetcher as typeof fetch, wait, random: () => 0, now: () => 0 });
    await expect(client.getQuery("token", "provider-1")).rejects.toMatchObject({ code: "provider_throttled" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });

  it("cancels an unread response when durable response recording rejects it", async () => {
    const cancel = vi.fn(async () => undefined);
    const body = new ReadableStream({ cancel });
    const client = new GraphAuditSearchClient({ fetch: vi.fn(async () => new Response(body)) as typeof fetch, wait: vi.fn(), random: () => 0 });
    await expect(client.getQuery("token", "provider-1", {
      onResponse: async () => { throw new AppError(409, "audit_execution_lost", "stale"); },
    })).rejects.toMatchObject({ code: "audit_execution_lost" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not schedule a network retry beyond the remaining request budget", async () => {
    const wait = vi.fn(async () => undefined);
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValue(29_900);
    const client = new GraphAuditSearchClient({ fetch: vi.fn(async () => { throw new TypeError("network"); }) as typeof fetch, wait, random: () => 0, now });
    await expect(client.getQuery("token", "provider-1")).rejects.toMatchObject({ code: "provider_error" });
    expect(wait).not.toHaveBeenCalled();
  });

  it("does not dispatch after asynchronous durable admission consumes an abort", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async () => response(query()));
    const client = new GraphAuditSearchClient({ fetch: fetcher as typeof fetch, wait: vi.fn(), random: () => 0 });
    await expect(client.getQuery("token", "provider-1", {
      signal: controller.signal,
      beforeRequest: async () => { controller.abort(new DOMException("cancelled", "AbortError")); },
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("applies the attempt deadline while consuming a stalled response body", async () => {
    const cancel = vi.fn(async () => undefined);
    const body = new ReadableStream({ pull: () => new Promise(() => undefined), cancel });
    const client = new GraphAuditSearchClient({ fetch: vi.fn(async () => new Response(body, { status: 200 })) as typeof fetch,
      wait: vi.fn(), random: () => 0, requestTimeoutMs: 5 });
    await expect(client.getQuery("token", "provider-1")).rejects.toMatchObject({ code: "provider_error" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("projects allowlisted typed metadata, discards content and counts unknown fields", async () => {
    const fetcher = vi.fn(async () => response({ value: [record()] }));
    const client = new GraphAuditSearchClient({ fetch: fetcher as typeof fetch, wait: vi.fn(), random: () => 0 });
    const result = await client.listRecords("token", "provider-1", tenantId);
    expect(result).toMatchObject({ complete: true, pageCount: 1, providerRowCount: 1, storedRowCount: 1 });
    expect(result.records[0]).toMatchObject({
      nativeEventId: "33333333-3333-4333-8333-333333333333", agentId: "CopilotStudio.Declarative.44444444-4444-4444-8444-444444444444",
      appIdentity: "Copilot.Studio.55555555-5555-4555-8555-555555555555", messages: [{ id: "message-1", isPrompt: true }], contentAvailable: false,
    });
    expect(result.unknownFieldCount).toBe(3);
    expect(JSON.stringify(result)).not.toContain("discard-me");
  });

  it("projects the selected Copilot and Studio source records without conflating their user types", async () => {
    const client = new GraphAuditSearchClient({ fetch: vi.fn(async () => response({ value: [record(), studioRecord()] })) as typeof fetch, wait: vi.fn(), random: () => 0 });
    const result = await client.listRecords("token", "provider-1", tenantId);
    expect(result.records).toEqual([
      expect.objectContaining({
        projectionVersion: 1, nativeEventId: "33333333-3333-4333-8333-333333333333", auditLogRecordType: "copilotInteraction",
        actorUserType: "regular", agentId: "CopilotStudio.Declarative.44444444-4444-4444-8444-444444444444",
        appIdentity: "Copilot.Studio.55555555-5555-4555-8555-555555555555", appHost: "Teams",
        messages: [{ id: "message-1", isPrompt: true }], contentAvailable: false,
      }),
      expect.objectContaining({
        projectionVersion: 1, nativeEventId: "66666666-6666-4666-8666-666666666666", auditLogRecordType: "powerPlatformAdministratorActivity",
        operation: "BotCreate", actorUserType: "admin", botId: "bot-1", environmentId: "environment-1",
        agentId: null, appIdentity: null, messages: [], contentAvailable: false,
      }),
    ]);
  });

  it("rejects message aliases and malformed Copilot message references", async () => {
    const malformedMessages = [
      [{ Id: "message-1", isPrompt: true }],
      [{ ID: "message-1", IsPrompt: true }],
      [{ ID: "", isPrompt: true }],
      [{ ID: "message-1", isPrompt: "true" }],
      [null],
    ];
    for (const Messages of malformedMessages) {
      const client = new GraphAuditSearchClient({ fetch: vi.fn(async () => response({ value: [recordWithDynamicProperties({ CopilotEventData: copilotEventData({ Messages }) })] })) as typeof fetch, wait: vi.fn(), random: () => 0 });
      await expect(client.listRecords("token", "provider-1", tenantId)).rejects.toMatchObject({ code: "provider_schema" });
    }
  });

  it("rejects unsupported wrapper and native common-schema types", async () => {
    const invalidRecords = [
      record({ "@odata.type": "#microsoft.graph.security.defaultAuditData" }),
      recordWithDynamicProperties({ RecordType: 256 }),
      ...["0", -1, 11, 1.5, true].map(UserType => recordWithDynamicProperties({ UserType })),
    ];
    for (const invalidRecord of invalidRecords) {
      const client = new GraphAuditSearchClient({ fetch: vi.fn(async () => response({ value: [invalidRecord] })) as typeof fetch, wait: vi.fn(), random: () => 0 });
      await expect(client.listRecords("token", "provider-1", tenantId)).rejects.toMatchObject({ code: "provider_schema" });
    }
  });

  it("rejects legacy string auditData and cross-tenant records", async () => {
    const stringData = new GraphAuditSearchClient({ fetch: vi.fn(async () => response({ value: [record({ auditData: "{}" })] })) as typeof fetch, wait: vi.fn(), random: () => 0 });
    await expect(stringData.listRecords("token", "provider-1", tenantId)).rejects.toMatchObject({ code: "provider_schema" });
    const crossTenant = new GraphAuditSearchClient({ fetch: vi.fn(async () => response({ value: [record({ organizationId: "99999999-9999-4999-8999-999999999999" })] })) as typeof fetch, wait: vi.fn(), random: () => 0 });
    await expect(crossTenant.listRecords("token", "provider-1", tenantId)).rejects.toMatchObject({ code: "scope_mismatch" });
  });

  it("deduplicates native IDs only within one result and safely handles wrappers without them", async () => {
    const sameNative = record({ id: "wrapper-2" });
    const noNativeA = record({ id: "wrapper-3", auditData: { "@odata.type": "#microsoft.graph.security.defaultAuditData", dynamicProperties: { "@odata.type": "#microsoft.graph.security.auditRecordTypeDictionary", OrganizationId: tenantId } } });
    const noNativeB = record({ id: "wrapper-4", auditData: { "@odata.type": "#microsoft.graph.security.defaultAuditData", dynamicProperties: { "@odata.type": "#microsoft.graph.security.auditRecordTypeDictionary", OrganizationId: tenantId } } });
    const client = new GraphAuditSearchClient({ fetch: vi.fn(async () => response({ value: [record(), sameNative, noNativeA, noNativeB] })) as typeof fetch, wait: vi.fn(), random: () => 0 });
    const result = await client.listRecords("token", "provider-1", tenantId);
    expect(result.providerRowCount).toBe(4);
    expect(result.records.map(value => value.wrapperId)).toEqual(["wrapper-1", "wrapper-3", "wrapper-4"]);
  });

  it("rejects conflicting rows with one native audit event ID", async () => {
    const conflicting = record({ id: "wrapper-2", operation: "Other" });
    const client = new GraphAuditSearchClient({ fetch: vi.fn(async () => response({ value: [record(), conflicting] })) as typeof fetch, wait: vi.fn(), random: () => 0 });
    await expect(client.listRecords("token", "provider-1", tenantId)).rejects.toMatchObject({ code: "provider_schema" });
  });

  it("rejects conflicting repeated wrapper rows", async () => {
    const client = new GraphAuditSearchClient({ fetch: vi.fn(async () => response({ value: [record(), record({ operation: "Other" })] })) as typeof fetch, wait: vi.fn(), random: () => 0 });
    await expect(client.listRecords("token", "provider-1", tenantId)).rejects.toMatchObject({ code: "provider_schema" });
  });

  it("returns truthful partial coverage at a bounded page limit", async () => {
    const pages = Array.from({ length: 20 }, (_, index) => response({ value: [], "@odata.nextLink": `https://graph.microsoft.com/v1.0/security/auditLog/queries/provider-1/records?$skiptoken=${index + 1}` }));
    const client = new GraphAuditSearchClient({ fetch: vi.fn(async () => pages.shift()!) as typeof fetch, wait: vi.fn(), random: () => 0 });
    await expect(client.listRecords("token", "provider-1", tenantId)).resolves.toMatchObject({ complete: false, pageCount: 20, nextLink: expect.any(String) });
  });

  it("preserves records as partial when a later page fails", async () => {
    const nextLink = "https://graph.microsoft.com/v1.0/security/auditLog/queries/provider-1/records?$skiptoken=next";
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ value: [record()], "@odata.nextLink": nextLink }))
      .mockResolvedValue(response({}, 503));
    const client = new GraphAuditSearchClient({ fetch: fetcher as typeof fetch, wait: vi.fn(), random: () => 0 });
    await expect(client.listRecords("token", "provider-1", tenantId)).resolves.toMatchObject({
      complete: false, pageCount: 1, providerRowCount: 1, storedRowCount: 1, nextLink, partialReason: "provider_error",
    });
  });

  it("preserves records as partial when a later response stream fails or exceeds its byte limit", async () => {
    const streamFailureLink = "https://graph.microsoft.com/v1.0/security/auditLog/queries/provider-1/records?$skiptoken=stream";
    const failedStream = new ReadableStream({
      start(controller) { controller.error(new TypeError("socket reset while reading")); },
    });
    const streamClient = new GraphAuditSearchClient({ fetch: vi.fn()
      .mockResolvedValueOnce(response({ value: [record()], "@odata.nextLink": streamFailureLink }))
      .mockResolvedValueOnce(new Response(failedStream, { status: 200 })) as typeof fetch, wait: vi.fn(), random: () => 0 });
    await expect(streamClient.listRecords("token", "provider-1", tenantId)).resolves.toMatchObject({
      complete: false, pageCount: 1, providerRowCount: 1, storedRowCount: 1, nextLink: streamFailureLink, partialReason: "provider_error",
    });

    const oversizedLink = "https://graph.microsoft.com/v1.0/security/auditLog/queries/provider-1/records?$skiptoken=oversized";
    const oversizedClient = new GraphAuditSearchClient({ fetch: vi.fn()
      .mockResolvedValueOnce(response({ value: [record()], "@odata.nextLink": oversizedLink }))
      .mockResolvedValueOnce(new Response("x".repeat(2_000_001), { status: 200 })) as typeof fetch, wait: vi.fn(), random: () => 0 });
    await expect(oversizedClient.listRecords("token", "provider-1", tenantId)).resolves.toMatchObject({
      complete: false, pageCount: 1, providerRowCount: 1, storedRowCount: 1, nextLink: oversizedLink, partialReason: "provider_result_limit",
    });
  });

  it("does not publish partial success after provider authorization loss or schema corruption", async () => {
    const authLink = "https://graph.microsoft.com/v1.0/security/auditLog/queries/provider-1/records?$skiptoken=auth";
    const authClient = new GraphAuditSearchClient({ fetch: vi.fn()
      .mockResolvedValueOnce(response({ value: [record()], "@odata.nextLink": authLink }))
      .mockResolvedValueOnce(response({}, 401)) as typeof fetch, wait: vi.fn(), random: () => 0 });
    await expect(authClient.listRecords("token", "provider-1", tenantId)).rejects.toMatchObject({ code: "authorization_expired" });

    const schemaLink = "https://graph.microsoft.com/v1.0/security/auditLog/queries/provider-1/records?$skiptoken=schema";
    const schemaClient = new GraphAuditSearchClient({ fetch: vi.fn()
      .mockResolvedValueOnce(response({ value: [record()], "@odata.nextLink": schemaLink }))
      .mockResolvedValueOnce(response({ value: [record({ organizationId: "99999999-9999-4999-8999-999999999999" })] })) as typeof fetch,
      wait: vi.fn(), random: () => 0 });
    await expect(schemaClient.listRecords("token", "provider-1", tenantId)).rejects.toMatchObject({ code: "scope_mismatch" });
  });

  it("preserves records as partial when the activation deadline aborts a later page", async () => {
    const controller = new AbortController();
    const nextLink = "https://graph.microsoft.com/v1.0/security/auditLog/queries/provider-1/records?$skiptoken=deadline";
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ value: [record()], "@odata.nextLink": nextLink }))
      .mockImplementationOnce(async () => {
        controller.abort(new DOMException("deadline", "TimeoutError"));
        throw controller.signal.reason;
      });
    const client = new GraphAuditSearchClient({ fetch: fetcher as typeof fetch, wait: vi.fn(), random: () => 0 });
    await expect(client.listRecords("token", "provider-1", tenantId, { signal: controller.signal })).resolves.toMatchObject({
      complete: false, pageCount: 1, storedRowCount: 1, nextLink,
    });
  });

  it("rejects provider links whose path only shares the expected prefix", async () => {
    const nextLink = "https://graph.microsoft.com/v1.0/security/auditLog/queries/provider-1/records-evil?$skiptoken=next";
    const client = new GraphAuditSearchClient({ fetch: vi.fn(async () => response({ value: [], "@odata.nextLink": nextLink })) as typeof fetch, wait: vi.fn(), random: () => 0 });
    await expect(client.listRecords("token", "provider-1", tenantId)).rejects.toMatchObject({ code: "invalid_provider_link" });
  });

  it("rejects query-list pagination into descendants of the collection path", async () => {
    const nextLink = "https://graph.microsoft.com/v1.0/security/auditLog/queries/provider-1?$skiptoken=wrong-resource";
    const fetcher = vi.fn(async () => response({ value: [], "@odata.nextLink": nextLink }));
    const client = new GraphAuditSearchClient({ fetch: fetcher as typeof fetch, wait: vi.fn(), random: () => 0 });
    await expect(client.listQueries("token")).rejects.toMatchObject({ code: "invalid_provider_link" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("enforces recent UTC structured filters and blocks injected fields", () => {
    expect(validatePurviewAuditFilters(filters, { now })).toEqual(filters);
    expect(() => validatePurviewAuditFilters({ ...filters, operations: ["BotDelete"] }, { now })).toThrow(/operations/);
    expect(() => validatePurviewAuditFilters({ ...filters, operations: [] }, { now })).toThrow(/at least one/);
    expect(() => validatePurviewAuditFilters({ ...filters, keywordFilter: "anything" }, { now })).toThrowError(AppError);
    expect(() => validatePurviewAuditFilters({ ...filters, startDateTime: "2026-09-01T00:00:00.000Z" }, { now })).toThrow(/recent UTC range/);
    expect(() => validatePurviewAuditFilters({ ...filters, startDateTime: "2026-02-30T11:00:00.000Z" }, { now })).toThrow(/exact UTC timestamp/);
    expect(() => validatePurviewAuditFilters({ ...filters, ipAddresses: ["1.2.3.4' or true"] }, { now })).toThrow(/ipAddresses/);
    expect(() => validatePurviewAuditFilters({ ...filters, objectIds: [7] }, { now })).toThrow(/objectIds/);
  });
});