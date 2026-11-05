// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mcpMetadataMaximumBytes, mcpSettingsMaximumBytes, parseBoundedMcpJson, parseMcpRuntimeMetadata, parseMcpSettingsJson,
  type McpRuntimeMetadata, type McpSettings,
} from "../../../backend/src/types/mcpSettings";
import { getMcpSettings } from "./client";

function metadata(): McpRuntimeMetadata {
  return {
    binding: {
      tenantId: "11111111-1111-1111-1111-111111111111",
      apiClientId: "22222222-2222-2222-2222-222222222222",
      mcpClientId: "33333333-3333-3333-3333-333333333333",
      resourceUrl: "https://mcp.example.invalid/mcp",
    },
    redirectUris: ["http://localhost:53109/callback"],
    serverInfo: { name: "Agent Control", version: "0.1.0" },
    instructions: "Exact runtime instructions", storageReady: true, transport: "streamable-http",
    tools: [{ name: "saved_read", inputSchema: { type: "object" } }],
  };
}

function settings(runtime = metadata()): Extract<McpSettings, { state: "available" }> {
  return {
    state: "available", configured: { resourceUrl: runtime.binding.resourceUrl, localHostPort: 3003 },
    runtime, observedAt: "2026-11-04T10:00:00.000Z",
  };
}

function respond(raw: string) {
  const fetcher = vi.fn().mockResolvedValue(new Response(raw, {
    headers: { "Content-Type": "application/json", "X-Request-ID": "synthetic-mcp-settings" },
  }));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

afterEach(() => vi.unstubAllGlobals());

describe("MCP settings wire contract", () => {
  it("preserves a full 4 MiB runtime catalog through the settings envelope and browser stream", async () => {
    const runtime = metadata();
    runtime.tools[0].inputSchema.description = "";
    runtime.tools[0].inputSchema.description = "x".repeat(
      mcpMetadataMaximumBytes - Buffer.byteLength(JSON.stringify(runtime)),
    );
    const raw = JSON.stringify(runtime);
    expect(Buffer.byteLength(raw)).toBe(mcpMetadataMaximumBytes);
    const verified = parseMcpRuntimeMetadata(parseBoundedMcpJson(raw));
    const payload = JSON.stringify(settings(verified));
    expect(Buffer.byteLength(payload)).toBeGreaterThan(mcpMetadataMaximumBytes);
    respond(payload);
    const result = await getMcpSettings();
    expect(result.state).toBe("available");
    if (result.state !== "available") throw new Error("Expected available runtime metadata.");
    expect(result.runtime.tools[0].inputSchema.description).toBe(runtime.tools[0].inputSchema.description);
  });

  it("preserves the runtime's supported depth when nested in a settings envelope", async () => {
    const runtime = metadata();
    runtime.tools[0].inputSchema.nested = JSON.parse("[".repeat(44) + "0" + "]".repeat(44));
    const verified = parseMcpRuntimeMetadata(parseBoundedMcpJson(JSON.stringify(runtime)));
    const payload = JSON.stringify(settings(verified));
    respond(payload);
    await expect(getMcpSettings()).resolves.toEqual(settings(runtime));
    runtime.tools[0].inputSchema.nested = JSON.parse("[".repeat(45) + "0" + "]".repeat(45));
    expect(() => parseMcpSettingsJson(JSON.stringify(settings(runtime)))).toThrow(SyntaxError);
  });

  it("preserves the runtime's supported token count when nested in a settings envelope", async () => {
    const runtime = metadata();
    runtime.tools[0].inputSchema.enum = [];
    const overhead = [...JSON.stringify(runtime).matchAll(/"(?:[^"\\]|\\.)*"|[{}[\]]/g)].length;
    const values = Array<string>(250_000 - overhead).fill("value");
    runtime.tools[0].inputSchema.enum = values;
    const verified = parseMcpRuntimeMetadata(parseBoundedMcpJson(JSON.stringify(runtime)));
    respond(JSON.stringify(settings(verified)));
    await expect(getMcpSettings()).resolves.toEqual(settings(runtime));
    values.push("over-limit");
    expect(() => parseBoundedMcpJson(JSON.stringify(runtime))).toThrow(SyntaxError);
  });

  it("enforces the settings token ceiling including its wrapper", () => {
    const value = settings();
    value.runtime.tools[0].inputSchema.enum = [];
    const overhead = [...JSON.stringify(value).matchAll(/"(?:[^"\\]|\\.)*"|[{}[\]]/g)].length;
    const values = Array<string>(250_032 - overhead).fill("value");
    value.runtime.tools[0].inputSchema.enum = values;
    expect(parseMcpSettingsJson(JSON.stringify(value)).state).toBe("available");
    values.push("over-limit");
    expect(() => parseMcpSettingsJson(JSON.stringify(value))).toThrow(SyntaxError);
  });

  it("keeps the original runtime byte and depth limits", () => {
    expect(() => parseBoundedMcpJson(" ".repeat(mcpMetadataMaximumBytes) + "0")).toThrow(SyntaxError);
    expect(() => parseBoundedMcpJson("[".repeat(49) + "0" + "]".repeat(49))).toThrow(SyntaxError);
  });

  it("enforces the settings parser and streamed byte ceiling independently of Content-Length", async () => {
    const raw = JSON.stringify(settings());
    const bounded = raw + " ".repeat(mcpSettingsMaximumBytes - Buffer.byteLength(raw));
    respond(bounded);
    await expect(getMcpSettings()).resolves.toEqual(settings());
    expect(() => parseMcpSettingsJson(bounded + " ")).toThrow(SyntaxError);
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(bounded + " ")); },
      cancel,
    }), { headers: { "Content-Type": "application/json", "Content-Length": "1" } })));
    await expect(getMcpSettings()).rejects.toMatchObject({ status: 200, code: "invalid_response" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    '{"state":"not_configured","st\\u0061te":"not_configured"}',
    '{"state":"not_configured","unexpected":true}',
    "[]",
    "{",
  ])("rejects malformed or non-whitelisted settings (%#)", raw => {
    expect(() => parseMcpSettingsJson(raw)).toThrow(SyntaxError);
  });

  it.each(["not_configured", "unavailable", "binding_mismatch"] as const)("preserves the explicit %s state", async state => {
    const value: McpSettings = state === "not_configured" ? { state } :
      { state, configured: { resourceUrl: "" }, code: "metadata_unavailable" };
    const fetcher = respond(JSON.stringify(value));
    await expect(getMcpSettings()).resolves.toEqual(value);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/mcp/settings", expect.objectContaining({ credentials: "include" }));
  });

  it.each(["resource", "redirect", "timestamp"])("classifies an invalid %s as invalid metadata, not a network failure", async field => {
    const value = settings();
    if (field === "resource") value.runtime.binding.resourceUrl = "not a URL";
    else if (field === "redirect") value.runtime.redirectUris = ["not a URL"];
    else value.observedAt = "not a date";
    const payload = JSON.stringify(value);
    expect(() => parseMcpSettingsJson(payload)).toThrow(SyntaxError);
    respond(payload);
    await expect(getMcpSettings()).rejects.toMatchObject({
      status: 200, code: "invalid_response", requestId: "synthetic-mcp-settings",
    });
  });
});
