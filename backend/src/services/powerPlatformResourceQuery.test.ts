import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PowerPlatformResourceQueryClient } from "./powerPlatformResourceQuery.js";
import { agentCapabilityExport } from "./agentContextExport.js";
import { withTelemetryContext } from "./telemetry.js";

vi.mock("../db/pool.js", () => ({ pool: {}, secretValue: vi.fn(() => undefined) }));

const resource = {
  tenantId: "11111111-1111-1111-1111-111111111111",
  name: "agent-a",
  type: "microsoft.copilotstudio/agents",
  location: "unitedstates",
  properties: { connectionIdSharedByMaker: "must-not-be-retained" },
};

function fakeDeadlineTimers() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  vi.spyOn(AbortSignal, "timeout").mockImplementation(milliseconds => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Synthetic deadline", "TimeoutError")), milliseconds);
    return controller.signal;
  });
}

function delayedInventoryFetcher(delayMs: number) {
  return vi.fn((_input: string | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    const { Options: options } = JSON.parse(String(init?.body));
    const offset = Number(options.SkipToken ?? 0);
    const end = Math.min(offset + options.Top, 4_008);
    const timer = setTimeout(() => {
      init?.signal?.removeEventListener("abort", abort);
      resolve(Response.json({
        totalRecords: 4_008, count: end - offset, resultTruncated: end < 4_008 ? 1 : 0,
        ...(end < 4_008 ? { skipToken: String(end) } : {}),
        data: Array.from({ length: end - offset }, (_, index) => ({ ...resource, name: `agent-${offset + index}`, properties: {} })),
      }));
    }, delayMs);
    const abort = () => { clearTimeout(timer); reject(init?.signal?.reason); };
    if (init?.signal?.aborted) abort();
    else init?.signal?.addEventListener("abort", abort, { once: true });
  }));
}

describe("PowerPlatformResourceQueryClient", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  it("limits default collection to agents and contextual environments", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ totalRecords: 0, count: 0, resultTruncated: 0, data: [] }));
    const result = await new PowerPlatformResourceQueryClient(fetcher).query("opaque-token");
    expect(result.queriedTypes).toEqual(["microsoft.copilotstudio/agents", "microsoft.powerplatform/environments"]);
    const query = JSON.stringify(JSON.parse(fetcher.mock.calls[0][1].body as string).Clauses);
    expect(query).toContain("microsoft.copilotstudio/agents");
    expect(query).toContain("microsoft.powerplatform/environments");
    expect(query).not.toMatch(/powerapps|powerautomate|connector|environmentgroups/);
  });

  it.each(["microsoft.powerapps/apps", "microsoft.powerautomate/cloudflows", "microsoft.powerplatformconnector/connectors", "microsoft.powerplatform/environmentgroups"])("rejects retired source type %s", async type => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ totalRecords: 1, count: 1, resultTruncated: 0, data: [{ ...resource, type }] }));
    await expect(new PowerPlatformResourceQueryClient(fetcher).query("opaque-token")).rejects.toMatchObject({
      code: "provider_schema", diagnostics: { reason: "invalid_resource_type" },
    });
  });

  it("checks access with one bounded page and no continuation", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      totalRecords: 0,
      count: 0,
      resultTruncated: 0,
      data: [],
    }));
    await new PowerPlatformResourceQueryClient(fetcher).checkAccess("opaque-token");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetcher.mock.calls[0][1].body as string).Options.Top).toBe(1);
  });

  it.each([5_001, Number.MAX_SAFE_INTEGER])("checks access without enumerating or applying the refresh ceiling to %i total environments", async totalRecords => {
    const fetcher = vi.fn(async (_input: string | URL, _init?: RequestInit) => Response.json({
      totalRecords, count: 1, resultTruncated: 1, skipToken: "next",
      data: [{ ...resource, type: "microsoft.powerplatform/environments" }],
    }));
    const client = new PowerPlatformResourceQueryClient(fetcher);

    await expect(client.checkAccess("opaque-token")).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).Options).toEqual({ Top: 1, Skip: 0 });
    await expect(client.query("opaque-token", ["microsoft.powerplatform/environments"]))
      .rejects.toMatchObject({ code: "provider_schema", diagnostics: { reason: "invalid_total" } });
  });

  it("keeps the ten-second access-check deadline when a caller supplies a cancellation signal", async () => {
    fakeDeadlineTimers();
    const controller = new AbortController();
    const cancel = vi.fn();
    const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ cancel })));
    const client = new PowerPlatformResourceQueryClient(fetcher, { delay: async () => undefined });
    const settled = vi.fn();
    const pending = client.checkAccess("opaque-token", controller.signal)
      .then(result => ({ result }), error => ({ error }));
    void pending.then(settled);

    try {
      await vi.advanceTimersByTimeAsync(10_000);

      expect(settled).toHaveBeenCalledOnce();
      expect(await pending).toMatchObject({ error: { name: "TimeoutError" } });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      controller.abort(new Error("test cleanup"));
      await pending;
    }
  });

  it("preserves access-check cancellation during failed-response cleanup", async () => {
    const controller = new AbortController();
    const reason = new Error("access check cancelled");
    const fetcher = vi.fn(async () => new Response(new ReadableStream({
      cancel() { controller.abort(reason); },
    }), { status: 403 }));

    await expect(new PowerPlatformResourceQueryClient(fetcher).checkAccess("opaque-token", controller.signal))
      .rejects.toBe(reason);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(["redirect", "denied", "retry"])("does not wait for stalled response cleanup on %s", async mode => {
    const cleanup = Promise.withResolvers<void>();
    const cancel = vi.fn(() => cleanup.promise);
    const response = new Response(new ReadableStream({ cancel }), { status: mode === "denied" ? 403 : 503 });
    if (mode === "redirect") Object.defineProperty(response, "redirected", { value: true });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(Response.json({ totalRecords: 0, count: 0, resultTruncated: 0, data: [] }));
    const pending = new PowerPlatformResourceQueryClient(fetcher, { delay: async () => undefined })
      .checkAccess("opaque-token").then(() => "success", error => error);
    try {
      const result = await Promise.race([pending, setImmediate("still pending")]);
      if (mode === "retry") expect(result).toBe("success");
      else expect(result).toMatchObject({ code: mode === "redirect" ? "invalid_provider_link" : "provider_error" });
      expect(fetcher).toHaveBeenCalledTimes(mode === "retry" ? 2 : 1);
      expect(cancel).toHaveBeenCalledOnce();
    } finally { cleanup.resolve(); await pending; }
  });

  it.each([
    { totalRecords: -1, count: 0, resultTruncated: 0, data: [] },
    { totalRecords: Number.MAX_SAFE_INTEGER + 1, count: 1, resultTruncated: 1, skipToken: "next", data: [{ ...resource, type: "microsoft.powerplatform/environments" }] },
    { totalRecords: 2, count: 2, resultTruncated: 0, data: [{ ...resource, type: "microsoft.powerplatform/environments" }, { ...resource, name: "environment-b", type: "microsoft.powerplatform/environments" }] },
  ])("still rejects malformed or oversized access-check pages: %j", async page => {
    const fetcher = vi.fn(async () => Response.json(page));
    await expect(new PowerPlatformResourceQueryClient(fetcher).checkAccess("opaque-token"))
      .rejects.toMatchObject({ code: "provider_schema" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("discards nested details that are not documented for the returned resource type", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ totalRecords: 1, count: 1, resultTruncated: 0, data: [{
      ...resource, type: "microsoft.powerplatform/environments", properties: {
        powerPlatformConnectors: [{ connectorId: "unsupported-connector", operations: [{ operationId: "unsupported-operation" }] }],
        capabilitiesCounts: { distinctPowerPlatformConnectors: 7 },
      },
    }] }));
    const result = await new PowerPlatformResourceQueryClient(fetcher).query("opaque-token");
    expect(result.resources[0].details).toEqual({});
    expect(result.resources[0].unknownFieldCount).toBe(2);
    expect(JSON.stringify(result)).not.toContain("unsupported-connector");
  });

  it("retains raw authoring origin and GUID schema names without treating a declarative manifest as a bot", async () => {
    const nativeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const fetcher = vi.fn().mockResolvedValue(Response.json({ totalRecords: 1, count: 1, resultTruncated: 0, data: [{
      ...resource, name: nativeId, properties: {
        environmentId: `Default-${resource.tenantId}`, schemaName: nativeId,
        createdIn: "microsoft365CopilotAgentBuilder",
      },
    }] }));
    const result = await new PowerPlatformResourceQueryClient(fetcher).query("opaque-token");
    expect(result.resources[0]).toMatchObject({
      nativeId, authoringTool: "Microsoft 365 Copilot Agent Builder", agentKind: "agent_builder_agent",
      details: { schemaName: nativeId, createdIn: "microsoft365CopilotAgentBuilder" },
    });
    expect(result.resources[0].identifiers).not.toContainEqual(expect.objectContaining({ kind: "cds_bot_id" }));
    expect(result.resources[0].provenance.createdIn.path).toBe("properties.createdIn");
  });

  it("keeps unknown authoring origins available for diagnostics instead of discarding their values", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ totalRecords: 1, count: 1, resultTruncated: 0, data: [{
      ...resource, properties: { createdIn: "Future authoring service" },
    }] }));
    const result = await new PowerPlatformResourceQueryClient(fetcher).query("opaque-token");
    expect(result.resources[0]).toMatchObject({
      authoringTool: null, agentKind: "agent", details: { createdIn: "Future authoring service" },
    });
  });

  it.each(["Copilot Studio Lite", "copilotStudioLite", "COPILOT_STUDIO_LITE"])("recognizes %s as Agent Builder without fabricating a name or bot identity", async createdIn => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ totalRecords: 1, count: 1, resultTruncated: 0, data: [{
      ...resource, properties: { createdIn },
    }] }));
    const parsed = (await new PowerPlatformResourceQueryClient(fetcher).query("opaque-token")).resources[0];
    expect(parsed).toMatchObject({
      authoringTool: "Microsoft 365 Copilot Agent Builder", agentKind: "agent_builder_agent",
      displayName: null, lifecycle: "unknown", details: { createdIn },
      provenance: { authoringTool: { sourceSystem: "power_platform", path: "properties.createdIn", maturity: "ga" } },
    });
    expect(parsed.identifiers.some(value => value.kind === "cds_bot_id")).toBe(false);
  });

  it("rejects GUID casing aliases across pages but preserves distinct opaque native IDs", async () => {
    const nativeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const first = { ...resource, name: nativeId, properties: { environmentId: `Default-${resource.tenantId}` } };
    const second = { ...first, name: nativeId.toUpperCase(), properties: { environmentId: `default-${resource.tenantId}` } };
    const duplicate = vi.fn()
      .mockResolvedValueOnce(Response.json({ totalRecords: 2, count: 1, resultTruncated: 1, skipToken: "next", data: [first] }))
      .mockResolvedValueOnce(Response.json({ totalRecords: 2, count: 1, resultTruncated: 0, data: [second] }));
    await expect(new PowerPlatformResourceQueryClient(duplicate).query("opaque-token"))
      .rejects.toMatchObject({ code: "provider_schema", diagnostics: { reason: "duplicate_identity" } });
    const distinct = vi.fn().mockResolvedValue(Response.json({
      totalRecords: 2, count: 2, resultTruncated: 0,
      data: [{ ...first, name: "Opaque-A" }, { ...second, name: "opaque-a" }],
    }));
    expect((await new PowerPlatformResourceQueryClient(distinct).query("opaque-token")).resources).toHaveLength(2);
  });

  it("accepts case-equivalent GUID tenant and environment scope without broadening authorization", async () => {
    const tenantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const environmentId = `Default-${tenantId}`;
    const fetcher = vi.fn().mockResolvedValue(Response.json({ totalRecords: 1, count: 1, resultTruncated: 0, data: [{
      ...resource, tenantId: tenantId.toUpperCase(), properties: { environmentId: environmentId.toLowerCase() },
    }] }));
    const result = await new PowerPlatformResourceQueryClient(fetcher).query("opaque-token", ["microsoft.copilotstudio/agents"], {
      expectedTenantId: tenantId, environmentId,
    });
    expect(result.resources[0]).toMatchObject({ tenantId, environmentId: environmentId.toLowerCase() });
  });

  it("uses documented POST paging and enumerates a complete result", async () => {
    const progress: unknown[] = [];
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ totalRecords: 2, count: 1, resultTruncated: 1, skipToken: "next", data: [resource] }))
      .mockResolvedValueOnce(Response.json({ totalRecords: 2, count: 1, resultTruncated: 0, data: [{ ...resource, name: "agent-b" }] }));
    const client = new PowerPlatformResourceQueryClient(fetcher);

    const result = await client.query("opaque-token", ["microsoft.copilotstudio/agents"], { onProgress: value => { progress.push(value); } });
    expect(result).toMatchObject({
      totalRecords: 2,
      pages: 2,
      resources: [{ nativeId: "agent-a" }, { nativeId: "agent-b" }],
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenNthCalledWith(1, "https://api.powerplatform.com/resourcequery/resources/query?api-version=2024-10-01", expect.objectContaining({ method: "POST" }));
    const firstBody = JSON.parse(fetcher.mock.calls[0][1].body as string);
    expect(firstBody).toEqual({
      TableName: "PowerPlatformResources",
      Clauses: [
        { $type: "where", FieldName: "type", Operator: "in~", Values: ["'microsoft.copilotstudio/agents'"] },
        { $type: "orderby", FieldNamesAscDesc: { tenantId: "asc", type: "asc", "tostring(properties.environmentId)": "asc", name: "asc" } },
      ],
      Options: { Top: 100, Skip: 0 },
    });
    const nextBody = JSON.parse(fetcher.mock.calls[1][1].body as string);
    expect(nextBody.Clauses).toEqual(firstBody.Clauses);
    expect(nextBody.Options).toEqual({ Top: 100, SkipToken: "next" });
    expect(result.resources[0]).not.toHaveProperty("connectionIdSharedByMaker");
    expect(progress).toEqual([
      { pages: 1, observedCount: 1, totalRecords: 2 },
      { pages: 2, observedCount: 2, totalRecords: 2 },
    ]);
  });

  it.each([101, 201, 4_008])("enumerates %i agents and environments when explicit Skip overrides the continuation offset", async totalRecords => {
    const rows = Array.from({ length: totalRecords }, (_, index) => ({
      ...resource, name: `agent-${String(index).padStart(4, "0")}`, properties: {},
      ...(index % 2 ? { type: "microsoft.powerplatform/environments" } : {}),
    }));
    const progress = vi.fn();
    const fetcher = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const { Options: options }: { Options: { Top: number; Skip?: number; SkipToken?: string } } = JSON.parse(String(init?.body));
      // Resource Query inherits Resource Graph's explicit Skip precedence over SkipToken.
      const offset = options.Skip ?? Number(options.SkipToken ?? 0);
      const data = rows.slice(offset, offset + options.Top);
      const nextOffset = offset + data.length;
      const hasMore = nextOffset < totalRecords;
      return Response.json({
        totalRecords, count: data.length, data, resultTruncated: hasMore ? 1 : 0,
        ...(hasMore ? { skipToken: String(nextOffset) } : {}),
      });
    });

    const result = await new PowerPlatformResourceQueryClient(fetcher).query("opaque-token", undefined, { expectedTenantId: resource.tenantId, onProgress: progress });

    expect(result.resources.map(item => item.nativeId)).toEqual(rows.map(item => item.name));
    expect(result.resources.every(item => item.tenantId === resource.tenantId)).toBe(true);
    expect(result).toMatchObject({ totalRecords, pages: Math.ceil(totalRecords / 100) });
    expect(fetcher).toHaveBeenCalledTimes(Math.ceil(totalRecords / 100));
    expect(progress).toHaveBeenLastCalledWith({ pages: Math.ceil(totalRecords / 100), observedCount: totalRecords, totalRecords });
    for (const [, init] of fetcher.mock.calls.slice(1)) {
      expect(JSON.parse(String(init?.body)).Options).not.toHaveProperty("Skip");
    }
  });

  it("rejects duplicate identities across continuation pages without reporting a complete result", async () => {
    const progress = vi.fn();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ totalRecords: 2, count: 1, resultTruncated: 1, skipToken: "next", data: [resource] }))
      .mockResolvedValueOnce(Response.json({ totalRecords: 2, count: 1, resultTruncated: 0, data: [resource] }));

    await expect(new PowerPlatformResourceQueryClient(fetcher).query("opaque-token", undefined, { onProgress: progress }))
      .rejects.toMatchObject({ code: "provider_schema", message: "Power Platform inventory returned a duplicate resource identity." });
    expect(progress).toHaveBeenCalledExactlyOnceWith({ pages: 1, observedCount: 1, totalRecords: 2 });
    expect(vi.mocked(console.error).mock.calls.map(([entry]) => JSON.parse(entry))).toContainEqual(expect.objectContaining({
      event: "inventory_query_failed", page: 2, pages: 1, observedCount: 1,
      reason: "duplicate_identity", resourceIndex: 1, firstSeenPage: 1, resourceType: resource.type,
    }));
  });

  it.each([0, 1, 100, 101, 4_140, 5_000])("accepts a tokenless terminal page still marked truncated only after all %i resources are validated", async totalRecords => {
    const progress = vi.fn();
    const fetcher = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const { Options: options } = JSON.parse(String(init?.body));
      const offset = Number(options.SkipToken ?? 0);
      const count = Math.min(options.Top, totalRecords - offset);
      return Response.json({
        totalRecords, count, resultTruncated: 1,
        ...(offset + count < totalRecords ? { skipToken: String(offset + count) } : {}),
        data: Array.from({ length: count }, (_, index) => ({ ...resource, name: `agent-${offset + index}`, properties: {} })),
      });
    });
    const result = await new PowerPlatformResourceQueryClient(fetcher).query("opaque-token", undefined, { onProgress: progress });
    const pages = Math.max(1, Math.ceil(totalRecords / 100));
    expect(result).toMatchObject({ totalRecords, pages });
    expect(result.resources).toHaveLength(totalRecords);
    expect(new Set(result.resources.map(item => item.nativeId)).size).toBe(totalRecords);
    expect(fetcher).toHaveBeenCalledTimes(pages);
    expect(progress).toHaveBeenLastCalledWith({ pages, observedCount: totalRecords, totalRecords });
  });

  it.each([undefined, null, ""])("accepts a boolean terminal marker with absent continuation (%s) for both inventory and access checks", async skipToken => {
    const fetcher = vi.fn(async () => Response.json({ totalRecords: 1, count: 1, resultTruncated: true, skipToken, data: [resource] }));
    await expect(new PowerPlatformResourceQueryClient(fetcher).query("opaque-token")).resolves.toMatchObject({ totalRecords: 1, pages: 1 });
    const check = vi.fn(async () => Response.json({
      totalRecords: 1, count: 1, resultTruncated: true, skipToken,
      data: [{ ...resource, type: "microsoft.powerplatform/environments" }],
    }));
    await expect(new PowerPlatformResourceQueryClient(check).checkAccess("opaque-token")).resolves.toBeUndefined();
    expect(check).toHaveBeenCalledOnce();
  });

  it("still rejects an early missing continuation and does not mistake a sampled access check for complete enumeration", async () => {
    const progress = vi.fn();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ totalRecords: 3, count: 1, resultTruncated: 1, skipToken: "next", data: [resource] }))
      .mockResolvedValueOnce(Response.json({ totalRecords: 3, count: 1, resultTruncated: 1, data: [{ ...resource, name: "agent-b" }] }));
    await expect(new PowerPlatformResourceQueryClient(fetcher).query("opaque-token", undefined, { onProgress: progress }))
      .rejects.toMatchObject({ code: "provider_schema", message: expect.stringContaining("without a continuation token") });
    expect(progress).toHaveBeenCalledExactlyOnceWith({ pages: 1, observedCount: 1, totalRecords: 3 });
    const check = vi.fn(async () => Response.json({
      totalRecords: 2, count: 1, resultTruncated: true, data: [{ ...resource, type: "microsoft.powerplatform/environments" }],
    }));
    await expect(new PowerPlatformResourceQueryClient(check).checkAccess("opaque-token")).rejects.toMatchObject({ code: "provider_schema" });
  });

  it.each([
    { totalRecords: 2, resultTruncated: 1, data: [resource] },
    { totalRecords: 2, resultTruncated: 1, skipToken: "unexpected", data: [{ ...resource, name: "agent-b" }] },
    { totalRecords: 1, resultTruncated: 1, data: [{ ...resource, name: "agent-b" }] },
    { totalRecords: 2, resultTruncated: 1, data: [{ ...resource, tenantId: "foreign-tenant", name: "agent-b" }] },
    { totalRecords: 2, resultTruncated: 1, data: [{ ...resource, type: "microsoft.powerapps/canvasapps", name: "agent-b" }] },
  ])("keeps total, identity, continuation and scope checks on a terminal page: %j", async terminal => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ totalRecords: 2, count: 1, resultTruncated: 1, skipToken: "next", data: [resource] }))
      .mockResolvedValueOnce(Response.json({ count: 1, ...terminal }));
    await expect(new PowerPlatformResourceQueryClient(fetcher).query("opaque-token", ["microsoft.copilotstudio/agents"], { expectedTenantId: resource.tenantId }))
      .rejects.toMatchObject({ code: "provider_schema" });
  });

  it("logs first-page identity failures with field lengths and correlation but no provider contents", async () => {
    const privateName = "private-native-id".repeat(40);
    const providerRequestId = "22222222-2222-2222-2222-222222222222";
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      totalRecords: 4_008, count: 1, resultTruncated: 1, skipToken: "private-continuation",
      data: [{ ...resource, name: privateName, properties: { privateValue: "private-content" } }],
    }, { headers: { "x-ms-request-id": providerRequestId, "x-ms-correlation-request-id": "private-header" } }));

    await expect(withTelemetryContext({ requestId: "request-a", jobId: "job-a" }, () =>
      new PowerPlatformResourceQueryClient(fetcher).query("private-access-token"))).rejects.toMatchObject({ code: "provider_schema" });
    const events = [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.warn).mock.calls, ...vi.mocked(console.error).mock.calls]
      .map(([entry]) => JSON.parse(entry));
    expect(events).toContainEqual(expect.objectContaining({
      event: "inventory_query_failed", requestId: "request-a", jobId: "job-a", source: "inventory_refresh",
      stage: "validation", page: 1, pages: 0, observedCount: 0, totalRecords: 4_008, returnedCount: 1,
      errorCode: "provider_schema", reason: "identity_too_long", field: "name", length: privateName.length,
      maximumLength: 512, resourceType: resource.type, resourceIndex: 1,
    }));
    expect(events).toContainEqual(expect.objectContaining({ event: "inventory_provider_response", status: 200, providerRequestId }));
    expect(JSON.stringify(events)).not.toContain("private-");
    expect(JSON.stringify(events)).not.toContain(resource.tenantId);
  });

  it("aggregates omitted-field counts by page instead of logging every resource", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      totalRecords: 2, count: 2, resultTruncated: 0, data: [resource, { ...resource, name: "agent-b" }],
    }));
    await new PowerPlatformResourceQueryClient(fetcher).query("opaque-token");
    const warnings = vi.mocked(console.warn).mock.calls.map(([entry]) => JSON.parse(entry));
    expect(warnings).toEqual([expect.objectContaining({ event: "provider_schema_omission", page: 1, count: 2 })]);
    expect(vi.mocked(console.log).mock.calls.map(([entry]) => JSON.parse(entry))).toContainEqual(expect.objectContaining({
      event: "inventory_query_completed", pages: 1, observedCount: 2, totalRecords: 2, omittedFieldCount: 2,
    }));
  });

  it("identifies transport timeouts without logging exception messages", async () => {
    const timeout = new DOMException("private-network-details", "TimeoutError");
    const fetcher = vi.fn().mockRejectedValue(timeout);
    await expect(new PowerPlatformResourceQueryClient(fetcher, { maxAttempts: 1 }).query("opaque-token"))
      .rejects.toMatchObject({ status: 504, code: "provider_timeout", message: expect.stringContaining("page request timed out") });
    expect(vi.mocked(console.warn).mock.calls.map(([entry]) => JSON.parse(entry))).toContainEqual(expect.objectContaining({
      event: "inventory_provider_failure", page: 1, attempt: 1, stage: "transport", errorKind: "timeout",
    }));
    expect(vi.mocked(console.error).mock.calls.map(([entry]) => JSON.parse(entry))).toContainEqual(expect.objectContaining({
      event: "inventory_query_failed", page: 1, stage: "request", errorKind: "timeout",
    }));
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("private-network-details");
  });

  it.each([1_500, 2_000])("enumerates all 4008 rows with %i ms provider pages beyond the old 30-second deadline", async pageDelay => {
    fakeDeadlineTimers();
    const fetcher = delayedInventoryFetcher(pageDelay);
    const progress = vi.fn();
    const pending = new PowerPlatformResourceQueryClient(fetcher).query("opaque-token", undefined, { onProgress: progress })
      .then(result => ({ result }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(41 * pageDelay);
    const outcome = await pending;
    expect(outcome).not.toHaveProperty("error");
    expect(outcome).toMatchObject({ result: { totalRecords: 4_008, pages: 41 } });
    if ("result" in outcome) expect(outcome.result.resources).toHaveLength(4_008);
    expect(progress).toHaveBeenLastCalledWith({ pages: 41, observedCount: 4_008, totalRecords: 4_008 });
    expect(fetcher).toHaveBeenCalledTimes(41);
  });

  it("enforces the finite 120-second total deadline without returning partial inventory", async () => {
    fakeDeadlineTimers();
    const progress = vi.fn();
    const pending = new PowerPlatformResourceQueryClient(delayedInventoryFetcher(3_000)).query("opaque-token", undefined, { onProgress: progress })
      .then(result => ({ result }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await pending).toMatchObject({
      error: { status: 504, code: "provider_timeout", message: expect.stringContaining("120-second enumeration limit") },
    });
    expect(progress).toHaveBeenLastCalledWith({ pages: 39, observedCount: 3_900, totalRecords: 4_008 });
    expect(vi.mocked(console.error).mock.calls.map(([entry]) => JSON.parse(entry))).toContainEqual(expect.objectContaining({
      event: "inventory_query_failed", errorCode: "provider_timeout", errorKind: "timeout", durationMs: 120_000,
    }));
  });

  it("does not return a completed inventory after final progress recording exceeds the deadline", async () => {
    fakeDeadlineTimers();
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      totalRecords: 1, count: 1, resultTruncated: 0, data: [resource],
    }));
    const onProgress = vi.fn(() => new Promise<void>(resolve => setTimeout(resolve, 120_001)));
    const pending = new PowerPlatformResourceQueryClient(fetcher).query("opaque-token", undefined, { onProgress })
      .then(result => ({ result }), error => ({ error }));

    await vi.advanceTimersByTimeAsync(120_001);

    expect(await pending).toMatchObject({
      error: { status: 504, code: "provider_timeout", message: expect.stringContaining("120-second enumeration limit") },
    });
    expect(onProgress).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.mocked(console.log).mock.calls.map(([entry]) => JSON.parse(entry)))
      .not.toContainEqual(expect.objectContaining({ event: "inventory_query_completed" }));
  });

  it.each([false, true])("preserves cancellation during final progress recording (callback failure: %s)", async fails => {
    const controller = new AbortController();
    const reason = new Error("refresh cancelled");
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      totalRecords: 1, count: 1, resultTruncated: 0, data: [resource],
    }));
    let finishProgress!: () => void;
    const onProgress = vi.fn(async () => {
      controller.abort(reason);
      await new Promise<void>(resolve => { finishProgress = resolve; });
      if (fails) throw new Error("progress recording failed");
    });
    const pending = new PowerPlatformResourceQueryClient(fetcher).query("opaque-token", undefined, {
      signal: controller.signal, onProgress,
    }).then(result => ({ result }), error => ({ error }));
    const settled = vi.fn();
    void pending.then(settled);
    await vi.waitFor(() => expect(onProgress).toHaveBeenCalledOnce());
    expect(settled).not.toHaveBeenCalled();
    finishProgress();

    expect(await pending).toEqual({ error: reason });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.mocked(console.log).mock.calls.map(([entry]) => JSON.parse(entry)))
      .not.toContainEqual(expect.objectContaining({ event: "inventory_query_completed" }));
  });

  it("propagates progress recording failures when the query has not been cancelled", async () => {
    const failure = new Error("progress recording failed");
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      totalRecords: 1, count: 1, resultTruncated: 0, data: [resource],
    }));
    const onProgress = vi.fn().mockRejectedValue(failure);

    await expect(new PowerPlatformResourceQueryClient(fetcher).query("opaque-token", undefined, { onProgress }))
      .rejects.toBe(failure);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.mocked(console.log).mock.calls.map(([entry]) => JSON.parse(entry)))
      .not.toContainEqual(expect.objectContaining({ event: "inventory_query_completed" }));
  });

  it("applies the ten-second page limit while consuming a stalled response body", async () => {
    fakeDeadlineTimers();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const fetcher = vi.fn().mockResolvedValue(new Response(body));
    const pending = new PowerPlatformResourceQueryClient(fetcher, { maxAttempts: 1 }).query("opaque-token")
      .then(result => ({ result }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toMatchObject({ error: { status: 504, code: "provider_timeout" } });
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.mocked(console.warn).mock.calls.map(([entry]) => JSON.parse(entry))).toContainEqual(expect.objectContaining({
      event: "inventory_provider_failure", stage: "response_body", errorKind: "timeout",
    }));
  });

  it("rejects malformed and incomplete pages", async () => {
    const malformed = new PowerPlatformResourceQueryClient(vi.fn().mockResolvedValue(Response.json({ totalRecords: 1, count: 2, data: [resource] })));
    await expect(malformed.query("opaque-token")).rejects.toMatchObject({ code: "provider_schema" });

    const incomplete = new PowerPlatformResourceQueryClient(vi.fn().mockResolvedValue(Response.json({ totalRecords: 2, count: 1, resultTruncated: 0, data: [resource] })));
    await expect(incomplete.query("opaque-token")).rejects.toMatchObject({ code: "provider_schema" });
  });

  it.each([
    ["tenantId", "", "empty", 128],
    ["tenantId", "private-tenant-id".repeat(10), "oversized", 128],
    ["name", "", "empty", 512],
    ["name", "private-resource-id".repeat(30), "oversized", 512],
  ] as const)("identifies invalid %s length without exposing its value", async (field, value, reason, maximumLength) => {
    const progress = vi.fn();
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      totalRecords: 1, count: 1, resultTruncated: 0, data: [{ ...resource, [field]: value }],
    }));

    await expect(new PowerPlatformResourceQueryClient(fetcher).query("opaque-token", undefined, { onProgress: progress }))
      .rejects.toMatchObject({
        code: "provider_schema",
        message: `Power Platform inventory returned an ${reason} ${field} for ${resource.type} (length ${value.length}; expected 1-${maximumLength}).`,
      });
    expect(progress).not.toHaveBeenCalled();
  });

  it("preserves native identity values at their supported length limits", async () => {
    const tenantId = "t".repeat(128);
    const nativeId = "n".repeat(512);
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      totalRecords: 1, count: 1, resultTruncated: 0, data: [{ ...resource, tenantId, name: nativeId }],
    }));
    const result = await new PowerPlatformResourceQueryClient(fetcher).query("opaque-token");
    expect(result.resources[0]).toMatchObject({ tenantId, nativeId });
  });

  it.each(["tenantId", "name", "location"].flatMap(field => ["private\0text", "private\uD83Dtext", "private\uDE00text"]
    .map(value => ({ field, value }))))("rejects non-storable $field text before reporting progress ($value)", async ({ field, value }) => {
    const progress = vi.fn();
    const fetcher = vi.fn(async () => Response.json({
      totalRecords: 1, count: 1, resultTruncated: 0, data: [{ ...resource, [field]: value }],
    }));

    await expect(new PowerPlatformResourceQueryClient(fetcher).query("opaque-token", undefined, { onProgress: progress }))
      .rejects.toMatchObject({ code: "provider_schema", diagnostics: { field } });
    expect(progress).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("private");
  });

  it.each(["environmentId", "expectedTenantId"].flatMap(field => ["private\0scope", "private\uD83Dscope", "private\uDE00scope"]
    .map(value => ({ field, value }))))("rejects non-storable $field scope before dispatch ($value)", async ({ field, value }) => {
    const fetcher = vi.fn(async () => Response.json({ totalRecords: 0, count: 0, resultTruncated: 0, data: [] }));
    await expect(new PowerPlatformResourceQueryClient(fetcher).query("opaque-token", undefined, { [field]: value }))
      .rejects.toMatchObject({ code: "invalid_inventory_scope" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["private\0text", "private\uD83Dtext", "private\uDE00text"])("omits non-storable optional text and marks capability omissions partial (%s)", async value => {
    const properties = {
      displayName: value, environmentId: value, createdBy: value, ownerId: value, createdIn: value,
      name: value, botId: value, entraAppId: value, entraAgentId: value, entraAgentBlueprintId: value,
      channels: ["Teams", value],
      powerPlatformConnectors: [
        { connectorId: value, operations: [] },
        { connectorId: "valid", operations: [{ operationId: value }, { operationId: "read" }] },
      ],
    };
    const fetcher = vi.fn(async () => Response.json({ totalRecords: 1, count: 1, resultTruncated: 0, data: [{ ...resource, properties }] }));
    const result = await new PowerPlatformResourceQueryClient(fetcher).query("opaque-token");
    expect(result.resources[0]).toMatchObject({
      displayName: null, environmentId: null, createdBy: null,
      identifiers: [{ kind: "power_platform_resource_id", value: resource.name }],
      details: {
        channels: ["Teams"], connectorDetailsStatus: "partial", capabilityDetailsTruncated: true,
        connectors: [{ connectorId: "valid", operations: [{ operationId: "read" }] }],
      },
      unknownFieldCount: 13,
    });
    expect(result.resources[0].details).not.toHaveProperty("ownerId");
    expect(result.resources[0].details).not.toHaveProperty("createdIn");
    expect(result.resources[0].provenance).not.toHaveProperty("displayName");
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it.each([
    { channels: [], expected: [], omissions: 0 },
    { channels: ["Teams"], expected: ["Teams"], omissions: 0 },
    { channels: ["private\0channel"], expected: undefined, omissions: 1 },
    { channels: [null, 123], expected: undefined, omissions: 2 },
    { channels: ["Teams", false], expected: ["Teams"], omissions: 1 },
  ])("does not present an entirely malformed channel list as supplied empty: $channels", async ({ channels, expected, omissions }) => {
    const fetcher = vi.fn(async () => Response.json({
      totalRecords: 1, count: 1, resultTruncated: 0, data: [{ ...resource, properties: { channels } }],
    }));
    const result = await new PowerPlatformResourceQueryClient(fetcher).query("opaque-token");
    expect(result.resources[0].details.channels).toEqual(expected);
    expect(result.resources[0].unknownFieldCount).toBe(omissions);
    if (expected === undefined) expect(result.resources[0].provenance).not.toHaveProperty("channels");
    else expect(result.resources[0].provenance.channels.path).toBe("properties.channels");
  });

  it("retains valid supplementary Unicode without splitting a bounded location", async () => {
    const nativeId = "agent-😀";
    const properties = {
      displayName: "Agent 😀", environmentId: "environment-😀", channels: ["Channel 😀"],
      powerPlatformConnectors: [{ connectorId: "connector-😀", operations: [{ operationId: "read-😀" }] }],
    };
    const fetcher = vi.fn(async () => Response.json({
      totalRecords: 1, count: 1, resultTruncated: 0,
      data: [{ ...resource, name: nativeId, location: `${"x".repeat(255)}😀tail`, properties }],
    }));
    const result = await new PowerPlatformResourceQueryClient(fetcher).query("opaque-token");
    expect(result.resources[0]).toMatchObject({
      nativeId, displayName: properties.displayName, environmentId: properties.environmentId,
      location: "x".repeat(255),
      details: { channels: properties.channels, connectors: properties.powerPlatformConnectors, connectorDetailsStatus: "complete" },
    });
    expect(result.resources[0].identifiers).toContainEqual({ kind: "power_platform_resource_id", value: nativeId });
  });

  it.each(["", null, undefined])("still rejects absent tenant metadata (%s) on tenant-owned resources", async tenantId => {
    for (const type of ["microsoft.copilotstudio/agents", "microsoft.powerplatform/environments"]) {
      const fetcher = vi.fn().mockResolvedValue(Response.json({
        totalRecords: 1, count: 1, resultTruncated: 0, data: [{ ...resource, type, tenantId }],
      }));
      await expect(new PowerPlatformResourceQueryClient(fetcher).query("opaque-token", undefined, { expectedTenantId: resource.tenantId }))
        .rejects.toMatchObject({ code: "provider_schema" });
    }
  });

  it.each(["foreign-tenant", 42, {}, "x".repeat(129)])("does not replace foreign or malformed environment tenant metadata (%s)", async tenantId => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      totalRecords: 1, count: 1, resultTruncated: 0,
      data: [{ ...resource, type: "microsoft.powerplatform/environments", tenantId }],
    }));
    await expect(new PowerPlatformResourceQueryClient(fetcher).query("opaque-token", undefined, { expectedTenantId: resource.tenantId }))
      .rejects.toMatchObject({ code: "provider_schema" });
  });

  it("retains duplicate and environment-scope guards for environment context", async () => {
    const environment = { ...resource, type: "microsoft.powerplatform/environments" };
    const duplicate = vi.fn().mockResolvedValue(Response.json({ totalRecords: 2, count: 2, resultTruncated: 0, data: [environment, environment] }));
    await expect(new PowerPlatformResourceQueryClient(duplicate).query("opaque-token", undefined, { expectedTenantId: resource.tenantId }))
      .rejects.toMatchObject({ code: "provider_schema", message: expect.stringContaining("duplicate resource identity") });
    const outOfScope = vi.fn().mockResolvedValue(Response.json({ totalRecords: 1, count: 1, resultTruncated: 0, data: [environment] }));
    await expect(new PowerPlatformResourceQueryClient(outOfScope).query("opaque-token", undefined, { expectedTenantId: resource.tenantId, environmentId: "environment-a" }))
      .rejects.toMatchObject({ code: "provider_schema", message: expect.stringContaining("outside the requested") });
  });

  it("allowlists documented fields, preserves null semantics and discards secret or unknown values", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      totalRecords: 1,
      count: 1,
      resultTruncated: 0,
      data: [{
        ...resource,
        properties: {
          displayName: "Support agent",
          environmentId: "environment-a",
          name: "bot-a",
          botId: "bot-a",
          createdIn: "Microsoft 365 Copilot Agent Builder",
          lastPublishedAt: null,
          isQuarantined: null,
          entraAgentId: "entra-agent-a",
          entraAgentBlueprintId: "blueprint-a",
          powerPlatformConnectors: [{
            connectorId: "shared_service",
            operations: [{ operationId: "read", isEnabled: false, connectionIdSharedByMaker: "secret", createdBy: "private" }],
          }],
          capabilitiesCounts: { distinctPowerPlatformConnectors: 2, distinctPowerPlatformConnectorsOperations: 3 },
          sharedWithViewers: { entireTenant: true },
        },
        token: "must-not-survive",
      }],
    }));
    const client = new PowerPlatformResourceQueryClient(fetcher);
    const result = await client.query("opaque-token", ["microsoft.copilotstudio/agents"]);

    expect(result.resources[0]).toMatchObject({
      displayName: "Support agent",
      environmentId: "environment-a",
      authoringTool: "Microsoft 365 Copilot Agent Builder",
      creatorType: "unknown",
      agentKind: "agent_builder_agent",
      lifecycle: "draft",
      details: { capabilityDetailsTruncated: true, connectors: [{ connectorId: "shared_service", operations: [{ operationId: "read", isEnabled: false }] }] },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain("sharedWithViewers");
    expect(result.resources[0].details.isQuarantined).toBeUndefined();
    expect(result.resources[0].provenance.authoringTool).toMatchObject({ path: "properties.createdIn", maturity: "ga" });
    expect(result.unknownFieldCount).toBeGreaterThan(0);
  });

  it("retains documented operation creators and false values without connection credentials", async () => {
    const creator = "52bff06b-5db5-42cd-9919-28f95e3c07af";
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      totalRecords: 1, count: 1, resultTruncated: 0,
      data: [{ ...resource, properties: {
        powerPlatformConnectors: [{ connectorId: "shared_excelonlinebusiness", operations: [{
          operationId: "RunScriptProd", createdBy: creator, usedAs: "Topic Tool", isEnabled: false,
          requiresEndUserConsent: false, whenCanBeUsed: "ViaDirectReferenceOnly", connectionProvider: "Maker",
          connectionIdSharedByMaker: "private-connection", callbackUrl: "https://example.invalid?sig=private",
        }] }],
      } }],
    }));
    const result = await new PowerPlatformResourceQueryClient(fetcher).query("opaque-token", ["microsoft.copilotstudio/agents"]);
    expect(result.resources[0].details).toMatchObject({
      connectorDetailsStatus: "complete",
      connectors: [{ connectorId: "shared_excelonlinebusiness", operations: [{
        operationId: "RunScriptProd", createdBy: creator, usedAs: "Topic Tool", isEnabled: false,
        requiresEndUserConsent: false, whenCanBeUsed: "ViaDirectReferenceOnly", connectionProvider: "Maker",
      }] }],
    });
    expect(result.resources[0].provenance.connectors.path).toBe("properties.powerPlatformConnectors");
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it.each([
    { isEnabled: "false" }, { requiresEndUserConsent: 0 }, { createdBy: "not-a-guid" },
    { usedAs: "x".repeat(513) }, { connectionProvider: { secret: "private" } },
  ])("marks malformed optional operation fields partial rather than complete: %j", async invalid => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      totalRecords: 1, count: 1, resultTruncated: 0,
      data: [{ ...resource, properties: { powerPlatformConnectors: [{
        connectorId: "shared_test", operations: [{ operationId: "read", ...invalid }],
      }] } }],
    }));
    const result = await new PowerPlatformResourceQueryClient(fetcher).query("opaque-token", ["microsoft.copilotstudio/agents"]);
    expect(result.resources[0].details.connectorDetailsStatus).toBe("partial");
    expect(result.resources[0].details.connectors?.[0].operations).toEqual([{ operationId: "read" }]);
  });

  it.each([undefined, 200, 250])("keeps the documented 200-operation provider boundary truthful with total %s", async total => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      totalRecords: 1, count: 1, resultTruncated: 0,
      data: [{ ...resource, properties: {
        powerPlatformConnectors: [{ connectorId: "shared_test", operations: Array.from({ length: 200 }, (_, index) => ({ operationId: `op-${index}` })) }],
        capabilitiesCounts: { distinctPowerPlatformConnectors: 1, distinctPowerPlatformConnectorsOperations: total },
      } }],
    }));
    const result = await new PowerPlatformResourceQueryClient(fetcher).query("opaque-token", ["microsoft.copilotstudio/agents"]);
    expect(result.resources[0].details.connectorDetailsStatus).toBe(total === 200 ? "complete" : "partial");
    expect(result.resources[0].details.distinctPowerPlatformConnectorsOperations).toBe(total);
    expect(result.resources[0].details.connectors?.[0].operations).toHaveLength(200);
  });

  it.each([-1, "0", false, 1.5])("does not turn malformed capability total %s into zero or a complete list", async count => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      totalRecords: 1, count: 1, resultTruncated: false,
      data: [{ ...resource, properties: { powerPlatformConnectors: [], capabilitiesCounts: { distinctPowerPlatformConnectors: count } } }],
    }));
    const result = await new PowerPlatformResourceQueryClient(fetcher).query("opaque-token", ["microsoft.copilotstudio/agents"]);
    expect(result.resources[0].details).toMatchObject({ connectorDetailsStatus: "partial", connectors: [] });
    expect(result.resources[0].details.distinctPowerPlatformConnectors).toBeUndefined();
  });

  it.each(["capped", "malformed"] as const)("exports %s operation lists as partial retained details, not confirmed empty configuration", async reason => {
    const connectors = [
      ...(reason === "capped" ? [{
        connectorId: "first", operations: Array.from({ length: 200 }, (_, index) => ({ operationId: `read-${index}` })),
      }] : []),
      { connectorId: "unretained", operations: reason === "capped" ? [{ operationId: "read" }] : [{ operationId: null }] },
    ];
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      totalRecords: 1, count: 1, resultTruncated: 0,
      data: [{ ...resource, properties: {
        powerPlatformConnectors: connectors,
        capabilitiesCounts: {
          distinctPowerPlatformConnectors: connectors.length,
          distinctPowerPlatformConnectorsOperations: reason === "capped" ? 201 : 1,
        },
      } }],
    }));
    const result = await new PowerPlatformResourceQueryClient(fetcher).query("opaque-token", ["microsoft.copilotstudio/agents"]);
    const retained = result.resources[0];
    expect(retained.details.connectors?.at(-1)).toEqual({ connectorId: "unretained", operations: [] });
    expect(retained.details).toMatchObject({ connectorDetailsStatus: "partial", capabilityDetailsTruncated: true });
    const exported = agentCapabilityExport(retained);
    expect(exported).toMatchObject({
      connectorDetailsStatus: "partial",
      reportedOperationTotal: reason === "capped" ? 201 : 1,
      savedOperationDetails: reason === "capped" ? 200 : 0,
    });
    expect(JSON.parse(exported.configuredConnectors!).at(-1)).toEqual({ connectorId: "unretained", operations: [] });
  });

  it("classifies only explicit empty publication metadata as draft", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      totalRecords: 3,
      count: 3,
      resultTruncated: 0,
      data: [
        { ...resource, name: "explicit-draft", properties: { lastPublishedAt: null } },
        { ...resource, name: "absent-publication", properties: {} },
        { ...resource, name: "malformed-publication", properties: { lastPublishedAt: "not-a-date" } },
      ],
    }));

    const result = await new PowerPlatformResourceQueryClient(fetcher).query("opaque-token", ["microsoft.copilotstudio/agents"]);

    expect(result.resources.map(({ nativeId, lifecycle }) => ({ nativeId, lifecycle }))).toEqual([
      { nativeId: "explicit-draft", lifecycle: "draft" },
      { nativeId: "absent-publication", lifecycle: "unknown" },
      { nativeId: "malformed-publication", lifecycle: "unknown" },
    ]);
  });

  it.each([
    "2026-02-30T12:00:00Z", "2025-02-29T12:00:00Z", "2026-04-31T12:00:00Z",
    "2026-01-01T24:00:00Z", "0000-01-01T12:00:00Z", "2026-13-01T12:00:00Z",
    "2026-01-01T12:00:00+14:30", "2026-01-01T12:00:00", "2026-01-01", "1",
  ])("omits invalid or timezone-ambiguous timestamps without inventing a published lifecycle (%s)", async value => {
    const properties = { createdAt: value, lastPublishedAt: value, lastModifiedAt: value, quarantinedAt: value };
    const fetcher = vi.fn(async () => Response.json({
      totalRecords: 1, count: 1, resultTruncated: 0, data: [{ ...resource, properties }],
    }));
    const result = await new PowerPlatformResourceQueryClient(fetcher).query("opaque-token");
    expect(result.resources[0]).toMatchObject({
      createdAt: null, lastPublishedAt: null, lifecycle: "unknown", unknownFieldCount: 4,
    });
    expect(result.resources[0].details).not.toHaveProperty("lastModifiedAt");
    expect(result.resources[0].details).not.toHaveProperty("quarantinedAt");
    for (const field of Object.keys(properties)) expect(result.resources[0].provenance).not.toHaveProperty(field);
  });

  it.each([
    ["2024-02-29T12:34:56.1234567Z", "2024-02-29T12:34:56.123Z"],
    ["2024-02-29T12:34:56+02:30", "2024-02-29T10:04:56.000Z"],
    ["2026-01-01T01:00:00-03:00", "2026-01-01T04:00:00.000Z"],
  ])("keeps valid timestamp normalization and publication evidence (%s)", async (value, expected) => {
    const properties = { createdAt: value, lastPublishedAt: value, lastModifiedAt: value, quarantinedAt: value };
    const fetcher = vi.fn(async () => Response.json({
      totalRecords: 1, count: 1, resultTruncated: 0, data: [{ ...resource, properties }],
    }));
    const result = await new PowerPlatformResourceQueryClient(fetcher).query("opaque-token");
    expect(result.resources[0]).toMatchObject({
      createdAt: expected, lastPublishedAt: expected, lifecycle: "published", unknownFieldCount: 0,
      details: { lastModifiedAt: expected, quarantinedAt: expected },
    });
    for (const field of Object.keys(properties)) expect(result.resources[0].provenance[field].path).toBe(`properties.${field}`);
  });

  it("classifies authoring only from exact documented values", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      totalRecords: 4, count: 4, resultTruncated: 0,
      data: [
        { ...resource, name: "studio", properties: { createdIn: "Copilot Studio" } },
        { ...resource, name: "builder", properties: { createdIn: "Microsoft 365 Copilot Agent Builder" } },
        { ...resource, name: "unknown", properties: { createdIn: "Agent Builder custom" } },
        { ...resource, name: "environment", type: "microsoft.powerplatform/environments", properties: {} },
      ],
    }));
    const result = await new PowerPlatformResourceQueryClient(fetcher).query("opaque-token");

    expect(result.resources.map(({ authoringTool, agentKind }) => ({ authoringTool, agentKind }))).toEqual([
      { authoringTool: "Copilot Studio", agentKind: "copilot_studio_agent" },
      { authoringTool: "Microsoft 365 Copilot Agent Builder", agentKind: "agent_builder_agent" },
      { authoringTool: null, agentKind: "agent" },
      { authoringTool: null, agentKind: "not_agent" },
    ]);
  });

  it("uses per-resource field authority and maturity without leaking unrelated identity fields", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      totalRecords: 2, count: 2, resultTruncated: false,
      data: [
        { ...resource, name: "agent", properties: { isQuarantined: false, isManaged: true, entraAgentId: "exact-agent-id" } },
        { ...resource, name: "environment", type: "microsoft.powerplatform/environments", properties: { isManaged: true, environmentType: "Production", environmentGroupId: "group-a", isQuarantined: false, entraAgentId: "not-an-environment-identity" } },
      ],
    }));
    const result = await new PowerPlatformResourceQueryClient(fetcher).query("opaque-token");

    expect(result.resources[0]).toMatchObject({ details: { isQuarantined: false, isManaged: true } });
    expect(result.resources[0].identifiers).toContainEqual({ kind: "entra_agent_id", value: "exact-agent-id" });
    expect(result.resources[0].provenance.isQuarantined.maturity).toBe("preview");
    expect(result.resources[1].provenance.isManaged.maturity).toBe("ga");
    expect(result.resources[1].details).toEqual({ isManaged: true, environmentType: "Production", environmentGroupId: "group-a" });
    expect(result.resources[1].location).toBe("unitedstates");
    expect(JSON.stringify(result)).not.toContain("not-an-environment-identity");
    expect(result.unknownFieldCount).toBe(2);
  });

  it("distinguishes absent, supplied-empty and bounded partial capability details", async () => {
    const operations = Array.from({ length: 201 }, (_, index) => ({ operationId: `operation-${index}` }));
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      totalRecords: 4, count: 4, resultTruncated: 0,
      data: [
        { ...resource, name: "absent", properties: { capabilitiesCounts: { distinctPowerPlatformConnectors: 0, distinctPowerPlatformConnectorsOperations: 0 } } },
        { ...resource, name: "empty", properties: { powerPlatformConnectors: [] } },
        { ...resource, name: "partial", properties: { powerPlatformConnectors: [{ connectorId: "shared_test", operations }] } },
        { ...resource, name: "malformed", properties: { powerPlatformConnectors: [{ connectorId: "shared_test", operations: "unknown" }] } },
      ],
    }));
    const result = await new PowerPlatformResourceQueryClient(fetcher).query("opaque-token", ["microsoft.copilotstudio/agents"]);

    expect(result.resources[0].details).toMatchObject({ connectorDetailsStatus: "not_supplied", distinctPowerPlatformConnectors: 0, distinctPowerPlatformConnectorsOperations: 0 });
    expect(result.resources[0].details.connectors).toBeUndefined();
    expect(result.resources[1].details).toMatchObject({ connectorDetailsStatus: "complete", connectors: [] });
    expect(result.resources[2].details).toMatchObject({ connectorDetailsStatus: "partial", capabilityDetailsTruncated: true });
    expect(result.resources[2].details.connectors?.[0].operations).toHaveLength(200);
    expect(result.resources[3].details).toMatchObject({ connectorDetailsStatus: "partial", capabilityDetailsTruncated: true, connectors: [{ connectorId: "shared_test" }] });
    expect(result.resources[3].details.connectors?.[0]).not.toHaveProperty("operations");
  });

  it("rejects duplicate resources and retries throttled read-only POST queries within bounds", async () => {
    const delays: number[] = [];
    const duplicate = new PowerPlatformResourceQueryClient(vi.fn().mockResolvedValue(Response.json({ totalRecords: 2, count: 2, resultTruncated: 0, data: [resource, resource] })));
    await expect(duplicate.query("opaque-token")).rejects.toMatchObject({ code: "provider_schema" });

    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "2" } }))
      .mockResolvedValueOnce(Response.json({ totalRecords: 0, count: 0, resultTruncated: 0, data: [] }));
    const client = new PowerPlatformResourceQueryClient(fetcher, { delay: async value => { delays.push(value); } });
    await expect(client.query("opaque-token")).resolves.toMatchObject({ totalRecords: 0 });
    expect(delays).toEqual([2_000]);
    expect(vi.mocked(console.warn).mock.calls.map(([entry]) => JSON.parse(entry))).toContainEqual(expect.objectContaining({
      event: "inventory_provider_retry", page: 1, attempt: 1, reason: "throttled", retryDelayMs: 2_000,
    }));
  });

  it("validates bounded page metadata and expected response scope", async () => {
    for (const body of [
      null,
      [],
      { totalRecords: 5_001, count: 0, resultTruncated: 0, data: [] },
      { totalRecords: 0, count: 0, data: [] },
      { totalRecords: 0, count: 0, resultTruncated: 0, skipToken: "unexpected", data: [] },
    ]) {
      await expect(new PowerPlatformResourceQueryClient(vi.fn().mockResolvedValue(Response.json(body))).query("opaque-token")).rejects.toMatchObject({ code: "provider_schema" });
    }
    await expect(new PowerPlatformResourceQueryClient(vi.fn().mockResolvedValue(Response.json({ totalRecords: 1, count: 1, resultTruncated: 0, data: [resource] }))).query("opaque-token", ["microsoft.copilotstudio/agents"], { expectedTenantId: "tenant-b" })).rejects.toMatchObject({ code: "provider_schema" });
    await expect(new PowerPlatformResourceQueryClient(vi.fn().mockResolvedValue(Response.json({ totalRecords: 1, count: 1, resultTruncated: 0, data: [resource] }))).query("opaque-token", ["microsoft.powerplatform/environments"])).rejects.toMatchObject({ code: "provider_schema" });
    await expect(new PowerPlatformResourceQueryClient(vi.fn().mockResolvedValue(Response.json({ totalRecords: 1, count: 1, resultTruncated: 0, data: [resource] }))).query("opaque-token", undefined, { environmentId: "environment-b" })).rejects.toMatchObject({ code: "provider_schema" });
  });

  it("retries stream failures, disposes failed responses and does not treat an absent Retry-After as zero", async () => {
    const cancel = vi.fn();
    const failedBody = new ReadableStream({ cancel });
    const brokenBody = new ReadableStream({ pull(controller) { controller.error(new Error("stream reset")); } });
    const delays: number[] = [];
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(failedBody, { status: 503 }))
      .mockResolvedValueOnce(new Response(brokenBody))
      .mockResolvedValueOnce(Response.json({ totalRecords: 0, count: 0, resultTruncated: 0, data: [] }));
    const client = new PowerPlatformResourceQueryClient(fetcher, { maxAttempts: 3, delay: async value => { delays.push(value); } });

    await expect(client.query("opaque-token")).resolves.toMatchObject({ totalRecords: 0 });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([1_000, 2_000]);
  });

  it("rejects sovereign clouds and redirected responses before forwarding a bearer token", async () => {
    const fetcher = vi.fn();
    await expect(new PowerPlatformResourceQueryClient(fetcher).query("opaque-token", undefined, { cloud: "usgov" })).rejects.toMatchObject({ code: "unsupported_cloud" });
    expect(fetcher).not.toHaveBeenCalled();

    const redirected = Response.json({ totalRecords: 0, count: 0, resultTruncated: 0, data: [] });
    Object.defineProperties(redirected, { redirected: { value: true }, url: { value: "https://other.invalid/query" } });
    await expect(new PowerPlatformResourceQueryClient(vi.fn().mockResolvedValue(redirected)).query("opaque-token")).rejects.toMatchObject({ code: "invalid_provider_link" });
  });

  it("honors external cancellation without retrying the provider request", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async (_url: string | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      controller.abort(new Error("shutdown"));
    }));
    const client = new PowerPlatformResourceQueryClient(fetcher);
    await expect(client.query("opaque-token", undefined, { signal: controller.signal })).rejects.toThrow("shutdown");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("carries environment scope in a structured query clause", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ totalRecords: 0, count: 0, resultTruncated: 0, data: [] }));
    const environmentId = "environment-a'\"\\); or true; //";
    await new PowerPlatformResourceQueryClient(fetcher).query("opaque-token", ["microsoft.copilotstudio/agents"], { environmentId });
    expect(JSON.parse(fetcher.mock.calls[0][1].body as string).Clauses[1]).toEqual({
      $type: "where", FieldName: "properties.environmentId", Operator: "==", Values: [JSON.stringify(environmentId)],
    });
  });
});