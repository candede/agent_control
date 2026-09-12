import { describe, expect, it, vi } from "vitest";
import { PowerPlatformResourceQueryClient } from "./powerPlatformResourceQuery.js";

const resource = {
  tenantId: "11111111-1111-1111-1111-111111111111",
  name: "agent-a",
  type: "microsoft.copilotstudio/agents",
  location: "unitedstates",
  properties: { connectionIdSharedByMaker: "must-not-be-retained" },
};

describe("PowerPlatformResourceQueryClient", () => {
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

  it("discards nested details that are not documented for the returned resource type", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ totalRecords: 1, count: 1, resultTruncated: 0, data: [{
      ...resource, type: "microsoft.powerapps/codeapps", properties: {
        powerPlatformConnectors: [{ connectorId: "unsupported-connector", operations: [{ operationId: "unsupported-operation" }] }],
        capabilitiesCounts: { distinctPowerPlatformConnectors: 7 },
      },
    }] }));
    const result = await new PowerPlatformResourceQueryClient(fetcher).query("opaque-token");
    expect(result.resources[0].details).not.toHaveProperty("connectors");
    expect(result.resources[0].details).not.toHaveProperty("distinctPowerPlatformConnectors");
    expect(JSON.stringify(result)).not.toContain("unsupported-connector");
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
      Clauses: [{ $type: "where", FieldName: "type", Operator: "in~", Values: ["'microsoft.copilotstudio/agents'"] }],
      Options: { Top: 100, Skip: 0 },
    });
    expect(JSON.parse(fetcher.mock.calls[1][1].body as string).Options.SkipToken).toBe("next");
    expect(result.resources[0]).not.toHaveProperty("connectionIdSharedByMaker");
    expect(progress).toEqual([
      { pages: 1, observedCount: 1, totalRecords: 2 },
      { pages: 2, observedCount: 2, totalRecords: 2 },
    ]);
  });

  it("rejects malformed and incomplete pages", async () => {
    const malformed = new PowerPlatformResourceQueryClient(vi.fn().mockResolvedValue(Response.json({ totalRecords: 1, count: 2, data: [resource] })));
    await expect(malformed.query("opaque-token")).rejects.toMatchObject({ code: "provider_schema" });

    const incomplete = new PowerPlatformResourceQueryClient(vi.fn().mockResolvedValue(Response.json({ totalRecords: 2, count: 1, resultTruncated: 0, data: [resource] })));
    await expect(incomplete.query("opaque-token")).rejects.toMatchObject({ code: "provider_schema" });
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

  it("classifies authoring only from exact documented values", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      totalRecords: 4, count: 4, resultTruncated: 0,
      data: [
        { ...resource, name: "studio", properties: { createdIn: "Copilot Studio" } },
        { ...resource, name: "builder", properties: { createdIn: "Microsoft 365 Copilot Agent Builder" } },
        { ...resource, name: "unknown", properties: { createdIn: "Agent Builder custom" } },
        { ...resource, name: "workflow", type: "microsoft.powerautomate/m365agentflows", properties: {} },
      ],
    }));
    const result = await new PowerPlatformResourceQueryClient(fetcher).query("opaque-token", ["microsoft.copilotstudio/agents", "microsoft.powerautomate/m365agentflows"]);

    expect(result.resources.map(({ authoringTool, agentKind }) => ({ authoringTool, agentKind }))).toEqual([
      { authoringTool: "Copilot Studio", agentKind: "copilot_studio_agent" },
      { authoringTool: "Microsoft 365 Copilot Agent Builder", agentKind: "agent_builder_agent" },
      { authoringTool: null, agentKind: "agent" },
      { authoringTool: null, agentKind: "workflow_agent_flow" },
    ]);
  });

  it("uses per-resource field authority and maturity without leaking unrelated identity fields", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      totalRecords: 5, count: 5, resultTruncated: false,
      data: [
        { ...resource, name: "canvas", type: "microsoft.powerapps/canvasapps", properties: { isQuarantined: false, isManaged: true, entraAgentId: "not-an-app-identity" } },
        { ...resource, name: "model", type: "microsoft.powerapps/modeldrivenapps", properties: { ownerId: "not-applicable", appModuleId: "module-a" } },
        { ...resource, name: "environment", type: "microsoft.powerplatform/environments", properties: { isManaged: true, isQuarantined: false } },
        { ...resource, name: "connector", type: "microsoft.powerplatformconnector/connectors", location: "not-applicable", properties: { description: "Connector description", ownerId: "not-applicable", environmentId: "not-applicable", createdAt: "2026-09-08T00:00:00Z", operations: [] } },
        { ...resource, name: "group", type: "microsoft.powerplatform/environmentgroups", properties: { description: "Group description" } },
      ],
    }));
    const result = await new PowerPlatformResourceQueryClient(fetcher).query("opaque-token", ["microsoft.powerapps/canvasapps", "microsoft.powerapps/modeldrivenapps", "microsoft.powerplatform/environments", "microsoft.powerplatformconnector/connectors", "microsoft.powerplatform/environmentgroups"]);

    expect(result.resources[0]).toMatchObject({ details: { isQuarantined: false }, identifiers: [{ kind: "power_platform_resource_id", value: "canvas" }] });
    expect(result.resources[0].provenance.isQuarantined.maturity).toBe("ga");
    expect(result.resources[0].details.isManaged).toBeUndefined();
    expect(result.resources[1].details).toEqual({ appModuleId: "module-a", connectorDetailsStatus: "not_supplied" });
    expect(result.resources[2].provenance.isManaged.maturity).toBe("ga");
    expect(result.resources[3]).toMatchObject({ location: null, createdAt: null, environmentId: null, details: { description: "Connector description", connectorDetailsStatus: "complete" } });
    expect(result.resources[3].provenance.description.maturity).toBe("preview");
    expect(result.resources[4].provenance.description.maturity).toBe("ga");
    expect(JSON.stringify(result)).not.toContain("not-an-app-identity");
    expect(JSON.stringify(result)).not.toContain("not-applicable");
    expect(result.unknownFieldCount).toBeGreaterThanOrEqual(7);
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
    await expect(new PowerPlatformResourceQueryClient(vi.fn().mockResolvedValue(Response.json({ totalRecords: 1, count: 1, resultTruncated: 0, data: [resource] }))).query("opaque-token", ["microsoft.powerapps/canvasapps"])).rejects.toMatchObject({ code: "provider_schema" });
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
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
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