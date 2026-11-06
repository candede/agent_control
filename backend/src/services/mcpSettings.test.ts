import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { tenant } from "../auth/authFoundationTestSupport.js";
import { mcpMetadataMaximumBytes, parseBoundedMcpJson, parseMcpRuntimeMetadata } from "../types/mcpSettings.js";
import { getWorkbenchMetadata } from "./workbenchMetadata.js";
import { mcpBindingForTenant, readMcpSettings as readProjectedMcpSettings } from "./mcpSettings.js";
import type { McpAccessProfile } from "../types/mcpSettings.js";

const projection: McpAccessProfile = { audience: "adoption", operations: [], staffPreviewAuthorized: true,
  privacy: { hide_employee_details: false, hide_champion_employee: false } };
const readMcpSettings = (tenantId: string, signal?: AbortSignal, fetcher?: typeof fetch) =>
  readProjectedMcpSettings(tenantId, projection, signal, fetcher);

const original = config.tenants;
const key = Buffer.alloc(32, 217).toString("base64url") + "=";
const binding = { tenantId: tenant.tenantId, apiClientId: tenant.clientId,
  mcpClientId: tenant.integration!.clientId, resourceUrl: "https://mcp.example.invalid/mcp" };
function metadata() {
  return { binding, redirectUris: ["http://localhost:53109/callback"], serverInfo: { name: "Agent Control", version: "0.1.0" },
    instructions: " Exact\n<script>inert</script>  ", storageReady: true, transport: "streamable-http",
    tools: [{ name: "synthetic_saved_read", description: " Full\nexact description  ", inputSchema: { type: "object" }, outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false } }] };
}
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
beforeEach(() => {
  config.tenants = [tenant];
  for (const [name, value] of Object.entries({
    MCP_TENANT_ID: binding.tenantId, MCP_CLIENT_ID: binding.mcpClientId, MCP_API_CLIENT_ID: binding.apiClientId,
    MCP_PUBLIC_URL: binding.resourceUrl, MCP_METADATA_ORIGIN: "http://mcp:8000", MCP_LOCAL_HOST_PORT: "3003",
    MCP_AZURE_METADATA_TOKEN: key, MCP_METADATA_TOKEN_FILE: "",
  })) vi.stubEnv(name, value);
});
afterEach(() => { config.tenants = original; vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("bounded fixed-origin metadata reader", () => {
  it("uses the bound public Host while connecting only to the private metadata origin", async () => {
    let server: Server | undefined;
    const hosts: Array<string | undefined> = [];
    try {
      server = createServer((request, response) => {
        hosts.push(request.headers.host);
        if (request.headers.host !== new URL(binding.resourceUrl).host) {
          response.writeHead(421); response.end("Misdirected Request"); return;
        }
        expect(request.method).toBe("POST");
        expect(request.url).toBe("/internal/mcp-metadata");
        expect(request.headers["x-agent-control-mcp-metadata-token"]).toBe(key);
        expect(request.headers.origin).toBeUndefined();
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(metadata()));
      }).listen(0, "127.0.0.1");
      await new Promise<void>(resolve => server!.once("listening", resolve));
      vi.stubEnv("MCP_METADATA_ORIGIN", `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      expect(await readMcpSettings(tenant.tenantId)).toMatchObject({ state: "available", runtime: metadata() });
      expect(hosts).toEqual([new URL(binding.resourceUrl).host]);
    } finally {
      server?.closeAllConnections();
      await new Promise<void>(resolve => server?.close(() => resolve()));
    }
  });
  it("fetches only the configured private destination with independent auth and exact text", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json(metadata()));
    const value = await readMcpSettings(tenant.tenantId, undefined, fetcher);
    expect(value).toMatchObject({ state: "available", configured: { resourceUrl: binding.resourceUrl, localHostPort: 3003 },
      runtime: metadata(), observedAt: expect.any(String) });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith("http://mcp:8000/internal/mcp-metadata", expect.objectContaining({
      redirect: "error", method: "POST", body: JSON.stringify(projection),
      headers: { Accept: "application/json", "Content-Type": "application/json", Host: "mcp.example.invalid",
        "X-Agent-Control-Mcp-Metadata-Token": key },
    }));
    expect(JSON.stringify(value)).not.toContain(key);
  });
  it.each(["headers", "body"])("aborts native transport stalled at %s within the total deadline", async phase => {
    let server: Server | undefined;
    let disconnected = false;
    try {
      server = createServer((_request, response) => {
        response.once("close", () => { disconnected = true; });
        if (phase === "body") {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.write("{");
        }
      }).listen(0, "127.0.0.1");
      await new Promise<void>(resolve => server!.once("listening", resolve));
      vi.stubEnv("MCP_METADATA_ORIGIN", `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      expect(await readMcpSettings(tenant.tenantId)).toMatchObject({ state: "unavailable", code: "metadata_deadline" });
      await expect.poll(() => disconnected).toBe(true);
    } finally {
      server?.closeAllConnections();
      await new Promise<void>(resolve => server?.close(() => resolve()));
    }
  });
  it("keeps configured navigation scoped to a tenant, independent of fetch or credential availability", async () => {
    vi.stubEnv("MCP_AZURE_METADATA_TOKEN", "");
    const fetcher = vi.fn<typeof fetch>();
    expect(await readMcpSettings(tenant.tenantId, undefined, fetcher)).toMatchObject({ state: "unavailable", code: "metadata_configuration_unavailable" });
    expect(getWorkbenchMetadata(tenant.tenantId).views.some(view => view.id === "mcp-settings")).toBe(true);
    expect(getWorkbenchMetadata("other-tenant").views.some(view => view.id === "mcp-settings")).toBe(false);
    expect(await readMcpSettings("other-tenant", undefined, fetcher)).toEqual({ state: "not_configured" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await readMcpSettings(tenant.tenantId, undefined, async () => json(metadata()))).toMatchObject({ state: "unavailable" });
    vi.stubEnv("MCP_AZURE_METADATA_TOKEN", key);
    expect(await readMcpSettings(tenant.tenantId, undefined, async () => json(metadata()))).toMatchObject({ state: "available" });
  });
  it.each(["valid", "mode", "unreadable", "link"])("contains %s local metadata credential input", async kind => {
    const directory = fileURLToPath(new URL(`../../../artifacts/test-scratch/mcp-settings-${randomUUID()}/`, import.meta.url));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = `${directory}/key`;
    writeFileSync(path, key, { mode: 0o600 });
    try {
      if (kind === "mode") chmodSync(path, 0o644);
      if (kind === "unreadable") chmodSync(path, 0o000);
      if (kind === "link") symlinkSync(path, `${directory}/link`);
      vi.stubEnv("MCP_METADATA_TOKEN_FILE", kind === "link" ? `${directory}/link` : path);
      vi.stubEnv("MCP_AZURE_METADATA_TOKEN", "");
      const fetcher = vi.fn<typeof fetch>(async () => json(metadata()));
      expect(await readMcpSettings(tenant.tenantId, undefined, fetcher)).toMatchObject({
        state: kind === "valid" ? "available" : "unavailable",
      });
      expect(fetcher).toHaveBeenCalledTimes(kind === "valid" ? 1 : 0);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it.each(["MCP_CLIENT_ID", "MCP_API_CLIENT_ID"])("rejects configured %s binding drift before fetching", async name => {
    vi.stubEnv(name, "44444444-4444-4444-4444-444444444444");
    const fetcher = vi.fn<typeof fetch>();
    expect(await readMcpSettings(tenant.tenantId, undefined, fetcher)).toMatchObject({ state: "binding_mismatch" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["tenantId", "apiClientId", "mcpClientId", "resourceUrl"] as const)("withholds runtime %s mismatch", async field => {
    const value = metadata();
    value.binding = { ...binding, [field]: field === "resourceUrl" ? "https://other.invalid/mcp" : "44444444-4444-4444-4444-444444444444" };
    expect(await readMcpSettings(tenant.tenantId, undefined, async () => json(value))).toMatchObject({ state: "binding_mismatch" });
  });
  it.each(["", "@Microsoft.KeyVault(unresolved)", "weak", key.replace("=", ""), tenant.clientSecret])("fails optional credential input without fetching (%#)", async credential => {
    vi.stubEnv("MCP_AZURE_METADATA_TOKEN", credential);
    const fetcher = vi.fn<typeof fetch>();
    expect(await readMcpSettings(tenant.tenantId, undefined, fetcher)).toMatchObject({ state: "unavailable", code: "metadata_configuration_unavailable" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["https://a.invalid/path", "http://169.254.169.254", "http://mcp:8000/?url=x", "https://user:pass@a.invalid", "http://mcp:8000/"])("refuses invalid configured origin %s", async origin => {
    vi.stubEnv("MCP_METADATA_ORIGIN", origin);
    expect(mcpBindingForTenant(tenant.tenantId)?.code).toBe("metadata_configuration_unavailable");
  });
  it.each(["/internal/mcp-metadata", "/auth/callback"])("reserves metadata and authentication resource path %s", path => {
    vi.stubEnv("MCP_PUBLIC_URL", `https://mcp.example.invalid${path}`);
    expect(mcpBindingForTenant(tenant.tenantId)?.code).toBe("metadata_configuration_unavailable");
  });
  it("does not echo credentials or raw invalid configured intent through a scoped failure", async () => {
    vi.stubEnv("MCP_PUBLIC_URL", "https://accidental-configured-secret@mcp.example.invalid/mcp");
    const result = await readMcpSettings(tenant.tenantId);
    expect(result).toMatchObject({ state: "unavailable", configured: { resourceUrl: "" } });
    expect(JSON.stringify(result)).not.toContain("accidental-configured-secret");
    expect(getWorkbenchMetadata(tenant.tenantId).views.some(view => view.id === "mcp-settings")).toBe(true);
  });
  it("distinguishes reachable metadata from storage readiness without dropping the catalog", async () => {
    expect(await readMcpSettings(tenant.tenantId, undefined, async () => json({ ...metadata(), storageReady: false })))
      .toMatchObject({ state: "available", runtime: { storageReady: false, tools: metadata().tools } });
  });
  it("preserves supported exact root native-client callbacks", async () => {
    expect(await readMcpSettings(tenant.tenantId, undefined, async () => json({
      ...metadata(), redirectUris: ["http://127.0.0.1/", "https://client.example.invalid/"],
    }))).toMatchObject({ state: "available" });
  });
  it.each([401, 503])("cancels a rejected %s response body instead of leaking an unbounded stream", async status => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    expect(await readMcpSettings(tenant.tenantId, undefined, async () =>
      new Response(body, { status, headers: { "Content-Type": "application/json" } }))).toMatchObject({ state: "unavailable" });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it.each(["absent", "false"] as const)("enforces the exact 4 MiB streamed boundary with %s Content-Length", async length => {
    const value = metadata();
    const base = JSON.stringify(value);
    const padded = { ...value, tools: [{ ...value.tools[0], inputSchema: { type: "object", description: "" } }] };
    const overhead = Buffer.byteLength(JSON.stringify(padded));
    const raw = JSON.stringify(padded).replace('"description":""', `"description":"${"x".repeat(mcpMetadataMaximumBytes - overhead)}"`);
    expect(Buffer.byteLength(raw)).toBe(mcpMetadataMaximumBytes);
    expect(Buffer.byteLength(base)).toBeLessThan(mcpMetadataMaximumBytes);
    const respond = (body: string) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(body);
        for (let offset = 0; offset < bytes.length; offset += 16384) controller.enqueue(bytes.slice(offset, offset + 16384));
        controller.close();
      },
    }), { headers: { "Content-Type": "application/json", ...(length === "false" ? { "Content-Length": "1" } : {}) } });
    expect(await readMcpSettings(tenant.tenantId, undefined, async () => respond(raw))).toMatchObject({ state: "available" });
    expect(await readMcpSettings(tenant.tenantId, undefined, async () => respond(raw + " "))).toMatchObject({ state: "unavailable" });
  });
  it("holds the same three-second deadline over a stalled response body and cancels it", async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); }, cancel: cancelled });
    const pending = readMcpSettings(tenant.tenantId, undefined, async () => new Response(body, { headers: { "Content-Type": "application/json" } }));
    await vi.advanceTimersByTimeAsync(2999);
    expect(cancelled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ state: "unavailable", code: "metadata_deadline" });
    expect(cancelled).toHaveBeenCalledOnce();
  });
  it("aborts on caller disconnect without publishing a catalog", async () => {
    const controller = new AbortController();
    const cancelled = vi.fn();
    const pending = readMcpSettings(tenant.tenantId, controller.signal, async () =>
      new Response(new ReadableStream({ cancel: cancelled }), { headers: { "Content-Type": "application/json" } }));
    const rejection = expect(pending).rejects.toThrow();
    await Promise.resolve(); controller.abort();
    await rejection;
    expect(cancelled).toHaveBeenCalledOnce();
  });
  it.each([
    () => ({ ...metadata(), tools: [] }),
    () => ({ ...metadata(), tools: [metadata().tools[0], metadata().tools[0]] }),
    () => ({ ...metadata(), rawEnv: { sensitive: "not-allowed" } }),
    () => ({ ...metadata(), storageReady: "ready" }),
    () => ({ ...metadata(), tools: [{ ...metadata().tools[0], inputSchema: [] }] }),
  ])("rejects invalid shape rather than an empty success (%#)", async change => {
    expect(await readMcpSettings(tenant.tenantId, undefined, async () => json(change()))).toMatchObject({ state: "unavailable" });
  });
  it("rejects duplicate JSON keys and bounded-depth violations", () => {
    expect(() => parseBoundedMcpJson('{"tools":[],"to\\u006fls":[]}')).toThrow();
    expect(() => parseBoundedMcpJson("[".repeat(49) + "0" + "]".repeat(49))).toThrow();
    expect(() => parseMcpRuntimeMetadata(parseBoundedMcpJson(JSON.stringify(metadata())))).not.toThrow();
  });
  it("refuses redirects without a second request", async () => {
    let server: Server | undefined;
    let requests = 0;
    try {
      server = createServer((_request, response) => {
        requests++; response.writeHead(302, { Location: "http://127.0.0.1/secret" }); response.end();
      }).listen(0, "127.0.0.1");
      await new Promise<void>(resolve => server!.once("listening", resolve));
      vi.stubEnv("MCP_METADATA_ORIGIN", `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      expect(await readMcpSettings(tenant.tenantId)).toMatchObject({ state: "unavailable" });
      expect(requests).toBe(1);
    } finally { await new Promise<void>(resolve => server?.close(() => resolve())); }
  });
});
