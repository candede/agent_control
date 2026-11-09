import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { config, findTenantConfiguration } from "../config.js";
import {
  mcpMetadataMaximumBytes, parseBoundedMcpJson, parseMcpRuntimeMetadata,
  type McpAccessProfile, type McpBinding, type McpConfiguredSettings, type McpConnectionSettings, type McpDiscoveryConnection,
} from "../types/mcpSettings.js";

type BindingDecision = { configured: McpConfiguredSettings; binding: McpBinding; origin?: string; code?: string };
// Node and DOM stream declarations differ; share only the reader methods used here.
type MetadataReader = Pick<ReadableStreamDefaultReader<Uint8Array>, "read" | "cancel">;
type MetadataBody = Pick<ReadableStream<Uint8Array>, "cancel"> & { getReader(): MetadataReader };
type MetadataResponse = Pick<Response, "ok" | "headers"> & { body: MetadataBody | null };
const guid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const reserved = ["/health", "/ready", "/diagnostics", "/internal/mcp-metadata", "/authorize", "/token", "/consent", "/auth/callback", "/register", "/revoke"];

function configuredResourceUrl(raw: string) {
  try {
    const resource = new URL(raw);
    if (raw.length > 2048 || resource.href !== raw || resource.protocol !== "https:" || resource.port === "0" || resource.pathname === "/"
      || resource.pathname.includes("//") || resource.pathname.endsWith("/") || reserved.includes(resource.pathname) || resource.pathname.startsWith("/.well-known/")
      || resource.search || resource.hash || resource.username || resource.password || /[?#%\\\s*]/.test(raw)) return "";
    return raw;
  } catch { return ""; }
}

export function mcpBindingForTenant(tenantId: string): BindingDecision | undefined {
  if (process.env.MCP_TENANT_ID !== tenantId) return undefined;
  const tenant = findTenantConfiguration(tenantId);
  const binding = { tenantId, apiClientId: process.env.MCP_API_CLIENT_ID ?? "",
    mcpClientId: process.env.MCP_CLIENT_ID ?? "", resourceUrl: process.env.MCP_PUBLIC_URL ?? "" };
  const configured: McpConfiguredSettings = { resourceUrl: configuredResourceUrl(binding.resourceUrl) };
  const port = process.env.MCP_LOCAL_HOST_PORT;
  if (port && /^[1-9][0-9]{0,4}$/.test(port) && Number(port) <= 65535) configured.localHostPort = Number(port);
  const decision: BindingDecision = { configured, binding };
  if (!tenant || !guid.test(binding.apiClientId) || !guid.test(binding.mcpClientId)
    || tenant.clientId !== binding.apiClientId || tenant.integration?.clientId !== binding.mcpClientId
    || tenant.integration.audience !== binding.apiClientId) return { ...decision, code: "binding_mismatch" };
  try {
    const raw = process.env.MCP_METADATA_ORIGIN ?? "";
    const origin = new URL(raw);
    if (!configured.resourceUrl || origin.origin !== raw || origin.username || origin.password || origin.search || origin.hash
      || /[%\\\s*]/.test(raw) || !["http:", "https:"].includes(origin.protocol)
      || origin.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
        && !/^[a-z][a-z0-9-]*$/.test(origin.hostname)) throw new Error();
    return { ...decision, origin: raw };
  } catch { return { ...decision, code: "metadata_configuration_unavailable" }; }
}

export function readMcpDiscoveryConnection(tenantId: string): McpDiscoveryConnection {
  const decision = mcpBindingForTenant(tenantId);
  return !decision?.configured.resourceUrl || decision.code === "binding_mismatch"
    ? { state: "not_configured" } : { state: "available", resourceUrl: decision.configured.resourceUrl };
}

function metadataCredential() {
  let value: string;
  const path = process.env.MCP_METADATA_TOKEN_FILE;
  if (path) {
    if (process.env.MCP_AZURE_METADATA_TOKEN) throw new Error();
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 8192) throw new Error();
      value = readFileSync(fd, "utf8").trim();
    } finally { closeSync(fd); }
  } else value = process.env.MCP_AZURE_METADATA_TOKEN ?? "";
  if (!/^[A-Za-z0-9_-]{43}=$/.test(value) || Buffer.from(value, "base64url").length !== 32
    || Buffer.from(value, "base64url").toString("base64url") + "=" !== value
    || value === config.sessionSecret || config.tenants.some(tenant => tenant.clientSecret === value)) throw new Error();
  return value;
}

function requestMcpMetadata(url: string, options: RequestInit): Promise<MetadataResponse> {
  // Node fetch ignores Host overrides; private transport must retain the bound public MCP host.
  const target = new URL(url);
  const hostname = target.hostname.replace(/^\[|\]$/g, "");
  const request = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const outgoing = request(target, {
      method: "POST", signal: options.signal ?? undefined,
      headers: Object.fromEntries(new Headers(options.headers)),
      ...(target.protocol === "https:" ? { servername: isIP(hostname) ? "" : hostname } : {}),
    }, incoming => {
      if (incoming.statusCode !== 200) {
        incoming.destroy();
        reject(new Error("MCP metadata HTTP request failed."));
        return;
      }
      const iterator = incoming[Symbol.asyncIterator]();
      const cancel = async () => {
        incoming.destroy();
        await iterator.return?.();
      };
      resolve({
        ok: true,
        body: {
          cancel,
          getReader: () => ({
            async read() {
              const { done, value } = await iterator.next();
              if (done) return { done: true, value: undefined };
              if (!(value instanceof Uint8Array)) throw new Error("Invalid metadata response chunk.");
              return { done: false, value };
            },
            cancel,
          }),
        },
        headers: new Headers({ "Content-Type": incoming.headers["content-type"] ?? "" }),
      });
    });
    outgoing.once("error", reject);
    outgoing.end(options.body);
  });
}

export async function readMcpSettings(tenantId: string, projection: McpAccessProfile, signal?: AbortSignal, fetcher = requestMcpMetadata): Promise<McpConnectionSettings> {
  const decision = mcpBindingForTenant(tenantId);
  if (!decision) return { state: "not_configured" };
  const { configured, binding, origin, code } = decision;
  if (code) return { state: code === "binding_mismatch" ? "binding_mismatch" : "unavailable", configured, code };
  let credential: string;
  try { credential = metadataCredential(); }
  catch { return { state: "unavailable", configured, code: "metadata_configuration_unavailable" }; }
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timeout = setTimeout(() => controller.abort(), 3000);
  const deadline = performance.now() + 3000;
  let reader: MetadataReader | undefined;
  let body: MetadataBody | null | undefined;
  const cancel = () => { void (reader ? reader.cancel() : body?.cancel())?.catch(() => undefined); };
  controller.signal.addEventListener("abort", cancel, { once: true });
  try {
    const projected = JSON.stringify(projection);
    if (Buffer.byteLength(projected) > 65536) throw new Error("Metadata projection limit.");
    const response = await fetcher(`${origin}/internal/mcp-metadata`, {
      method: "POST", redirect: "error", signal: controller.signal,
      body: projected,
      headers: { Accept: "application/json", Host: new URL(binding.resourceUrl).host,
        "Content-Type": "application/json",
        "X-Agent-Control-Mcp-Metadata-Token": credential },
    });
    body = response.body;
    controller.signal.throwIfAborted();
    if (!response.ok || !response.body || !/^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? "")) throw new Error();
    reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let raw = "", size = 0;
    for (;;) {
      controller.signal.throwIfAborted();
      const { done, value } = await reader.read();
      controller.signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > mcpMetadataMaximumBytes) throw new Error();
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
    const runtime = parseMcpRuntimeMetadata(parseBoundedMcpJson(raw));
    if (performance.now() >= deadline) controller.abort();
    controller.signal.throwIfAborted();
    if (Object.keys(binding).some(key => runtime.binding[key as keyof McpBinding] !== binding[key as keyof McpBinding]))
      return { state: "binding_mismatch", configured, code: "binding_mismatch" };
    return { state: "available", configured, runtime, observedAt: new Date().toISOString() };
  } catch {
    signal?.throwIfAborted();
    return { state: "unavailable", configured, code: controller.signal.aborted ? "metadata_deadline" : "metadata_unavailable" };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", cancel);
    cancel();
  }
}
