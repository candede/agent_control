import type { DiscoveryPrivacy } from "./agentDiscovery.js";

export type McpAccessProfile = {
  audience: "end_user" | "adoption" | "admin";
  operations: { method: string; route: string; inputChoices?: { capabilityId?: string[]; operation?: string[] } }[];
  staffPreviewAuthorized: boolean; privacy: DiscoveryPrivacy;
};
export const mcpMetadataMaximumBytes = 4 * 1024 * 1024;
export const mcpSettingsMaximumBytes = mcpMetadataMaximumBytes + 16 * 1024;
export type McpBinding = { tenantId: string; apiClientId: string; mcpClientId: string; resourceUrl: string };
export type McpTool = {
  name: string; title?: string; description?: string;
  inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown>;
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  _meta?: Record<string, unknown>; icons?: unknown[]; execution?: Record<string, unknown>;
};
export type McpRuntimeMetadata = {
  binding: McpBinding; redirectUris: string[];
  serverInfo: { name: string; version: string; title?: string; description?: string; websiteUrl?: string; icons?: unknown[] };
  instructions: string; tools: McpTool[]; storageReady: boolean; transport: "streamable-http";
};
export type McpConfiguredSettings = { resourceUrl: string; localHostPort?: number };
export type McpDiscoveryConnection = { state: "not_configured" } | { state: "available"; resourceUrl: string };
export type McpConnectionSettings =
  | { state: "not_configured" }
  | { state: "unavailable" | "binding_mismatch"; configured: McpConfiguredSettings; code: string }
  | { state: "available"; configured: McpConfiguredSettings; runtime: McpRuntimeMetadata; observedAt: string };
export type McpSettings = McpConnectionSettings & {
  privacy: DiscoveryPrivacy; privacyScope: "end_user_and_preview";
};

function invalid(): never { throw new SyntaxError("Invalid MCP metadata."); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function fields(value: unknown, allowed: string[]) {
  const result = object(value);
  if (Object.keys(result).some(key => !allowed.includes(key))) invalid();
  return result;
}
function text(value: unknown, maximum: number, empty = false): string {
  if (typeof value !== "string" || value.length > maximum || !empty && !value.length) invalid();
  return value;
}
function url(value: unknown, redirect = false) {
  const raw = text(value, 2048);
  let parsed: URL;
  try { parsed = new URL(raw); }
  catch { invalid(); }
  if (parsed.href !== raw || parsed.username || parsed.password || parsed.search || parsed.hash
    || /[?#%\\\s*]/.test(raw) || !redirect && parsed.pathname === "/"
    || parsed.protocol !== "https:" && !(redirect && parsed.protocol === "http:"
      && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))) invalid();
  return raw;
}
export function parseBoundedMcpJson(raw: string): unknown {
  return parseBoundedJson(raw, mcpMetadataMaximumBytes, 48, 250_000);
}
function parseBoundedJson(raw: string, maximumBytes: number, maximumDepth: number, maximumTokens: number): unknown {
  if (typeof raw !== "string" || new TextEncoder().encode(raw).length > maximumBytes) invalid();
  const frames: Array<Set<string> | null> = [];
  let tokens = 0;
  for (let index = 0; index < raw.length; index++) {
    const token = raw[index];
    if (token !== '"' && token !== "{" && token !== "[" && token !== "}" && token !== "]") continue;
    if (++tokens > maximumTokens) invalid();
    if (token === "{" || token === "[") {
      frames.push(token === "{" ? new Set() : null);
      if (frames.length > maximumDepth) invalid();
    } else if (token === "}" || token === "]") frames.pop();
    else {
      const start = index++;
      for (; index < raw.length && raw[index] !== '"'; index++) {
        if (raw[index] === "\\") index++;
      }
      if (index >= raw.length) invalid();
      const keys = frames.at(-1);
      let next = index + 1;
      while (/[\t\n\r ]/.test(raw.charAt(next))) next++;
      if (!keys || raw.charAt(next) !== ":") continue;
      const key: string = JSON.parse(raw.slice(start, index + 1));
      if (keys.has(key)) invalid();
      keys.add(key);
    }
  }
  return JSON.parse(raw);
}
export function parseMcpRuntimeMetadata(value: unknown): McpRuntimeMetadata {
  const data = fields(value, ["binding", "redirectUris", "serverInfo", "instructions", "tools", "storageReady", "transport"]);
  const binding = fields(data.binding, ["tenantId", "apiClientId", "mcpClientId", "resourceUrl"]);
  for (const key of ["tenantId", "apiClientId", "mcpClientId"]) {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(text(binding[key], 36))) invalid();
  }
  url(binding.resourceUrl);
  if (!Array.isArray(data.redirectUris) || !data.redirectUris.length || data.redirectUris.length > 32
    || new Set(data.redirectUris).size !== data.redirectUris.length) invalid();
  data.redirectUris.forEach(uri => url(uri, true));
  const info = fields(data.serverInfo, ["name", "version", "title", "description", "websiteUrl", "icons"]);
  text(info.name, 256); text(info.version, 128);
  for (const key of ["title", "description", "websiteUrl"]) if (info[key] !== undefined) text(info[key], 16_384);
  if (info.icons !== undefined && (!Array.isArray(info.icons) || info.icons.length > 16)) invalid();
  text(data.instructions, 524_288);
  if (data.transport !== "streamable-http" || typeof data.storageReady !== "boolean"
    || !Array.isArray(data.tools) || !data.tools.length || data.tools.length > 256) invalid();
  const names = new Set<string>();
  for (const item of data.tools) {
    const tool = fields(item, ["name", "title", "description", "inputSchema", "outputSchema", "annotations", "_meta", "icons", "execution"]);
    const name = text(tool.name, 128);
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name) || names.has(name)) invalid();
    names.add(name);
    for (const key of ["title", "description"]) if (tool[key] !== undefined) text(tool[key], 524_288, true);
    object(tool.inputSchema);
    for (const key of ["outputSchema", "_meta", "execution"]) if (tool[key] !== undefined) object(tool[key]);
    if (tool.annotations !== undefined) {
      const hints = fields(tool.annotations, ["title", "readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]);
      if (hints.title !== undefined) text(hints.title, 256, true);
      for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"])
        if (hints[key] !== undefined && typeof hints[key] !== "boolean") invalid();
    }
    if (tool.icons !== undefined && (!Array.isArray(tool.icons) || tool.icons.length > 16)) invalid();
  }
  return data as McpRuntimeMetadata;
}
export function parseMcpSettingsJson(raw: string): McpSettings {
  // Budget for the settings wrapper without reducing the accepted runtime catalog.
  const data = object(parseBoundedJson(raw, mcpSettingsMaximumBytes, 49, 250_032));
  const privacy = fields(data.privacy, ["hide_employee_details", "hide_champion_employee"]);
  if (typeof privacy.hide_employee_details !== "boolean" || typeof privacy.hide_champion_employee !== "boolean"
    || data.privacyScope !== "end_user_and_preview") invalid();
  if (data.state === "not_configured") {
    fields(data, ["state", "privacy", "privacyScope"]); return data as McpSettings;
  }
  const configured = fields(data.configured, ["resourceUrl", "localHostPort"]);
  // Invalid configured intent is never presented as runtime evidence.
  text(configured.resourceUrl, 2048, true);
  if (configured.localHostPort !== undefined && (!Number.isInteger(configured.localHostPort)
    || Number(configured.localHostPort) < 1 || Number(configured.localHostPort) > 65535)) invalid();
  if (data.state === "available") {
    fields(data, ["state", "configured", "runtime", "observedAt", "privacy", "privacyScope"]);
    parseMcpRuntimeMetadata(data.runtime);
    const observed = text(data.observedAt, 64);
    const instant = new Date(observed);
    if (!Number.isFinite(instant.getTime()) || instant.toISOString() !== observed) invalid();
  } else if (data.state === "unavailable" || data.state === "binding_mismatch") {
    fields(data, ["state", "configured", "code", "privacy", "privacyScope"]);
    if (!/^[a-z_]{1,64}$/.test(text(data.code, 64))) invalid();
  } else invalid();
  return data as McpSettings;
}
