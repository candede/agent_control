import { EventEmitter } from "node:events";
import type { RequestOptions } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config, type TenantConfiguration } from "../config.js";
import { mcpMetadataMaximumBytes, type McpRuntimeMetadata } from "../types/mcpSettings.js";
import { readMcpSettings as readProjectedMcpSettings } from "./mcpSettings.js";
import type { McpAccessProfile } from "../types/mcpSettings.js";

const projection: McpAccessProfile = { audience: "adoption", operations: [], staffPreviewAuthorized: true,
  privacy: { hide_employee_details: false, hide_champion_employee: false } };
const readMcpSettings = (tenantId: string, signal?: AbortSignal) =>
  readProjectedMcpSettings(tenantId, projection, signal);

const mocks = vi.hoisted(() => ({ http: vi.fn(), https: vi.fn() }));
vi.mock("node:http", () => ({ request: mocks.http }));
vi.mock("node:https", () => ({ request: mocks.https }));
vi.mock("../db/pool.js", () => ({
  secretValue: (name: string) => name === "TENANTS_JSON" ? "[]"
    : name === "SESSION_SECRET" ? "synthetic-settings-unit-session-secret" : undefined,
}));

const tenant: TenantConfiguration = {
  tenantId: "11111111-1111-1111-1111-111111111111",
  clientId: "22222222-2222-2222-2222-222222222222",
  clientSecret: "synthetic-settings-client-secret", domains: ["example.invalid"], displayName: "Synthetic",
  integration: { clientId: "33333333-3333-3333-3333-333333333333",
    audience: "22222222-2222-2222-2222-222222222222", scope: "AgentControl.Access" },
};
const key = Buffer.alloc(32, 217).toString("base64url") + "=";
const metadata: McpRuntimeMetadata = {
  binding: { tenantId: tenant.tenantId, apiClientId: tenant.clientId,
    mcpClientId: tenant.integration!.clientId, resourceUrl: "https://public-mcp.example.invalid/mcp" },
  redirectUris: ["http://localhost:53109/callback"],
  serverInfo: { name: "Agent Control", version: "0.1.0" },
  instructions: " Exact\n<script>inert</script>  ", storageReady: true, transport: "streamable-http",
  tools: [{ name: "synthetic_saved_read", description: " Full\nexact description  ", inputSchema: { type: "object" } }],
};
const originalTenants = config.tenants;

beforeEach(() => {
  config.tenants = [tenant];
  mocks.http.mockReset();
  mocks.https.mockReset();
  for (const [name, value] of Object.entries({
    MCP_TENANT_ID: tenant.tenantId, MCP_CLIENT_ID: tenant.integration!.clientId,
    MCP_API_CLIENT_ID: tenant.clientId, MCP_PUBLIC_URL: metadata.binding.resourceUrl,
    MCP_METADATA_ORIGIN: "http://mcp:8000", MCP_AZURE_METADATA_TOKEN: key, MCP_METADATA_TOKEN_FILE: "",
  })) vi.stubEnv(name, value);
});
afterEach(() => {
  config.tenants = originalTenants;
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function nativeResponse(options: { status?: number; contentType?: string; body?: string | Uint8Array; stalled?: boolean;
  requestError?: Error; bodyError?: Error; https?: boolean } = {}) {
  const incoming = Object.assign(new PassThrough(), {
    statusCode: options.status ?? 200,
    headers: { "content-type": options.contentType ?? "application/json" },
  });
  const outgoing = Object.assign(new EventEmitter(), { end: vi.fn() });
  const received = Promise.withResolvers<void>();
  const transport = options.https ? mocks.https : mocks.http;
  transport.mockImplementation((_target: URL, _options: RequestOptions, receive: (stream: typeof incoming) => void) => {
    outgoing.end.mockImplementationOnce(() => {
      queueMicrotask(() => {
        if (options.requestError) outgoing.emit("error", options.requestError);
        else {
          receive(incoming);
          if (options.bodyError) incoming.destroy(options.bodyError);
          else if (options.stalled) incoming.write("{");
          else incoming.end(options.body ?? JSON.stringify(metadata));
        }
        received.resolve();
      });
    });
    return outgoing;
  });
  return { incoming, outgoing, received: received.promise, transport };
}

describe("native MCP metadata transport without sockets", () => {
  it("uses the private destination and public Host with an independently authenticated POST", async () => {
    const { transport, outgoing, incoming } = nativeResponse();
    const result = await readMcpSettings(tenant.tenantId);
    expect(result).toMatchObject({ state: "available", runtime: metadata });
    expect(JSON.stringify(result)).not.toContain(key);
    expect(transport).toHaveBeenCalledExactlyOnceWith(new URL("http://mcp:8000/internal/mcp-metadata"), {
      method: "POST", signal: expect.any(AbortSignal),
      headers: { accept: "application/json", "content-type": "application/json", host: "public-mcp.example.invalid",
        "x-agent-control-mcp-metadata-token": key },
    }, expect.any(Function));
    expect(mocks.https).not.toHaveBeenCalled();
    expect(outgoing.end).toHaveBeenCalledExactlyOnceWith(JSON.stringify(projection));
    expect(incoming.destroyed).toBe(true);
  });

  it.each(["?", "#"])("rejects a configured resource with an empty %s delimiter before requesting metadata", async delimiter => {
    vi.stubEnv("MCP_PUBLIC_URL", `${metadata.binding.resourceUrl}${delimiter}`);
    expect(await readMcpSettings(tenant.tenantId)).toMatchObject({
      state: "unavailable", configured: { resourceUrl: "" }, code: "metadata_configuration_unavailable",
    });
    expect(mocks.http).not.toHaveBeenCalled();
    expect(mocks.https).not.toHaveBeenCalled();
  });

  it.each(["?", "#"])("rejects runtime callbacks with an empty %s delimiter", async delimiter => {
    const { incoming } = nativeResponse({
      body: JSON.stringify({ ...metadata, redirectUris: [`${metadata.redirectUris[0]}${delimiter}`] }),
    });
    expect(await readMcpSettings(tenant.tenantId)).toMatchObject({
      state: "unavailable", code: "metadata_unavailable",
    });
    expect(incoming.destroyed).toBe(true);
  });

  it.each([
    ["https://private-mcp.example.invalid", "private-mcp.example.invalid"],
    ["https://127.0.0.1:8000", ""],
    ["https://[::1]:8000", ""],
  ])("uses the destination TLS identity for %s, independently of the public Host", async (origin, servername) => {
    vi.stubEnv("MCP_METADATA_ORIGIN", origin);
    const { transport } = nativeResponse({ https: true });
    expect(await readMcpSettings(tenant.tenantId)).toMatchObject({ state: "available", runtime: metadata });
    expect(transport).toHaveBeenCalledExactlyOnceWith(new URL(`${origin}/internal/mcp-metadata`),
      expect.objectContaining({ servername, headers: expect.objectContaining({ host: "public-mcp.example.invalid" }) }),
      expect.any(Function));
    expect(mocks.http).not.toHaveBeenCalled();
  });

  it.each([302, 401, 503])("destroys rejected HTTP %s streams without following a redirect", async status => {
    const { incoming, transport } = nativeResponse({ status });
    expect(await readMcpSettings(tenant.tenantId)).toMatchObject({ state: "unavailable", code: "metadata_unavailable" });
    expect(incoming.destroyed).toBe(true);
    expect(transport).toHaveBeenCalledOnce();
    expect(mocks.https).not.toHaveBeenCalled();
  });

  it.each([
    { contentType: "text/html", body: "<html>not metadata</html>" },
    { body: new Uint8Array([0xff]) },
    { body: " ".repeat(mcpMetadataMaximumBytes + 1) },
  ])("cancels invalid or oversized native response bodies (%#)", async options => {
    const { incoming } = nativeResponse(options);
    expect(await readMcpSettings(tenant.tenantId)).toMatchObject({ state: "unavailable", code: "metadata_unavailable" });
    expect(incoming.destroyed).toBe(true);
  });

  it.each(["requestError", "bodyError"] as const)("contains native %s failures", async phase => {
    const { incoming } = nativeResponse({ [phase]: new Error("Synthetic metadata transport failure.") });
    expect(await readMcpSettings(tenant.tenantId)).toMatchObject({ state: "unavailable", code: "metadata_unavailable" });
    if (phase === "bodyError") expect(incoming.destroyed).toBe(true);
  });

  it("cancels a stalled native stream at the total three-second deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { incoming, received, transport } = nativeResponse({ stalled: true });
    const operation = readMcpSettings(tenant.tenantId);
    await received;
    await vi.advanceTimersByTimeAsync(2999);
    expect(incoming.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await operation).toMatchObject({ state: "unavailable", code: "metadata_deadline" });
    expect(transport.mock.calls[0][1].signal.aborted).toBe(true);
    expect(incoming.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates caller cancellation and destroys the native stream", async () => {
    const controller = new AbortController();
    const { incoming, received, transport } = nativeResponse({ stalled: true });
    const operation = readMcpSettings(tenant.tenantId, controller.signal);
    const rejection = expect(operation).rejects.toMatchObject({ name: "AbortError" });
    await received;
    controller.abort();
    await rejection;
    expect(transport.mock.calls[0][1].signal.aborted).toBe(true);
    expect(incoming.destroyed).toBe(true);
  });
});
