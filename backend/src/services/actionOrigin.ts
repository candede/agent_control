import { AsyncLocalStorage } from "node:async_hooks";
import { TextDecoder } from "node:util";
import { AppError } from "../errors.js";
import { assertVerifiedPrincipal } from "../auth/requestPrincipal.js";
import { currentAuthority, authorityUser } from "../auth/authorityContext.js";
import type { RequestPrincipal } from "../types/requestPrincipal.js";
import type { AttributionField, AuditOriginV1, OriginFilters } from "../types/actionOrigin.js";
import type { AuditActor } from "../types/audit.js";
import { unknownOrigin } from "../types/actionOrigin.js";
export { unknownOrigin } from "../types/actionOrigin.js";

export const mcpContextHeader = "X-Agent-Control-Mcp-Context";
const context = new AsyncLocalStorage<AuditOriginV1>();
const acceptedActor = new AsyncLocalStorage<AuditActor & { tenantId: string }>();
const unknownField: AttributionField = Object.freeze({ value: null, evidence: "unknown" });
export function currentActionOrigin() { return context.getStore() ?? unknownOrigin; }
export function withActionOrigin<T>(origin: AuditOriginV1, operation: () => T): T {
  return context.run(parseStoredOrigin(origin), operation);
}
// A durable parent may admit a missing child after a crash. Authorization still
// uses the current source; only the original, private-scope attribution is retained.
export function withAcceptedActionOrigin<T>(origin: AuditOriginV1, actor: AuditActor & { tenantId: string }, operation: () => T): T {
  const authority = currentAuthority();
  if (authority && (actor.tenantId !== authority.principal.tenantId || actor.homeAccountId !== authority.principal.principalId)) {
    throw new AppError(403, "scope_mismatch", "Accepted control attribution belongs to another principal.");
  }
  return acceptedActor.run(actor, () => withActionOrigin(origin, operation));
}
export function initiatingActor<T extends AuditActor>(fallback: T): T | (AuditActor & { tenantId: string }) {
  return acceptedActor.getStore() ?? lifecycleActor(fallback);
}
function invalid(): never { throw new AppError(400, "invalid_action_origin", "Action attribution is malformed or contains reserved authority fields."); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) invalid();
  return value as Record<string, unknown>;
}
export function originLabel(value: unknown, maximum = 256): string {
  if (typeof value !== "string" || !value.length || [...value].length > maximum
    || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) invalid();
  return value;
}
function field(value: unknown, maximum = 256): AttributionField {
  return value === undefined ? unknownField : Object.freeze({ value: originLabel(value, maximum), evidence: "reported" });
}
function trace(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(text)) invalid();
  return text;
}
export function deriveActionOrigin(principal: RequestPrincipal, requestId: string, header?: string): AuditOriginV1 {
  assertVerifiedPrincipal(principal);
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(requestId)) invalid();
  let descriptor: Record<string, unknown> = {};
  if (header !== undefined) {
    if (principal.transport !== "bearer" || !/^[A-Za-z0-9_-]+$/.test(header) || header.length > 5462) invalid();
    const bytes = Buffer.from(header, "base64url");
    if (bytes.length > 4096 || bytes.toString("base64url") !== header) invalid();
    try {
      descriptor = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        ["version", "client", "callingAgent", "mcpCallId"]);
    } catch { invalid(); }
    if (descriptor.version !== 1) invalid();
  }
  const client = descriptor.client === undefined ? {} : object(descriptor.client, ["id", "name", "version"]);
  const agent = descriptor.callingAgent === undefined ? {} : object(descriptor.callingAgent, ["id", "name"]);
  const origin: AuditOriginV1 = Object.freeze({
    version: 1, channel: principal.transport === "browser" ? "webapp" : "mcp",
    integrationClientId: principal.integrationClientId,
    client: Object.freeze({ id: field(client.id), name: field(client.name), version: field(client.version, 64) }),
    callingAgent: Object.freeze({ id: field(agent.id), name: field(agent.name) }),
    requestId, mcpCallId: trace(descriptor.mcpCallId),
  });
  if (Buffer.byteLength(JSON.stringify(origin)) > 4096) invalid();
  return origin;
}
export function parseStoredOrigin(value: unknown): AuditOriginV1 {
  if (value === undefined || value === null) return unknownOrigin;
  const origin = object(value, ["version", "channel", "integrationClientId", "client", "callingAgent", "requestId", "mcpCallId"]);
  if (origin.version !== 1 || !["webapp", "mcp", "unknown"].includes(String(origin.channel))) invalid();
  const parseField = (value: unknown, maximum = 256): AttributionField => {
    const entry = object(value, ["value", "evidence"]);
    if (entry.evidence === "unknown" && entry.value === null) return unknownField;
    if (!["authenticated", "reported"].includes(String(entry.evidence))) invalid();
    return Object.freeze({ value: originLabel(entry.value, maximum), evidence: entry.evidence as "authenticated" | "reported" });
  };
  const client = object(origin.client, ["id", "name", "version"]), agent = object(origin.callingAgent, ["id", "name"]);
  if (origin.integrationClientId !== null && (typeof origin.integrationClientId !== "string"
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(origin.integrationClientId))) invalid();
  if (origin.requestId !== null && (typeof origin.requestId !== "string"
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(origin.requestId))) invalid();
  const result: AuditOriginV1 = Object.freeze({
    version: 1, channel: origin.channel as AuditOriginV1["channel"], integrationClientId: origin.integrationClientId as string | null,
    client: Object.freeze({ id: parseField(client.id), name: parseField(client.name), version: parseField(client.version, 64) }),
    callingAgent: Object.freeze({ id: parseField(agent.id), name: parseField(agent.name) }),
    requestId: origin.requestId as string | null, mcpCallId: trace(origin.mcpCallId),
  });
  if (Buffer.byteLength(JSON.stringify(result)) > 4096
    || result.channel === "unknown" && JSON.stringify(result) !== JSON.stringify(unknownOrigin)
    || result.channel !== "unknown" && !result.integrationClientId) invalid();
  return result;
}
export function initiatingOrigin(actor: AuditActor) {
  const authority = currentAuthority();
  const original = acceptedActor.getStore();
  if (authority && (actor.tenantId !== authority.principal.tenantId || actor.homeAccountId !== authority.principal.principalId
    || actor.username !== (original ?? authority.principal).username || actor.displayName !== (original ?? authority.principal).displayName)) {
    throw new AppError(400, "invalid_audit_actor", "Audit actor does not match the verified initiating authority.");
  }
  return currentActionOrigin();
}
export function lifecycleActor<T extends AuditActor>(fallback: T): T | (AuditActor & { tenantId: string }) {
  return currentAuthority() ? authorityUser(currentAuthority()!) as AuditActor & { tenantId: string } : fallback;
}
export function parseOriginFilters(query: Record<string, unknown>): OriginFilters {
  const result: OriginFilters = {};
  for (const key of ["originChannel", "originIntegrationClientId", "originClientId", "originCallingAgentId"] as const) {
    const value = query[key];
    if (value === undefined) continue;
    if (key === "originChannel") {
      if (typeof value !== "string" || !["webapp", "mcp", "unknown"].includes(value)) invalid();
      result[key] = value as OriginFilters["originChannel"];
    } else {
      result[key] = originLabel(value);
      if (key === "originIntegrationClientId" && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value as string)) invalid();
    }
  }
  return result;
}
export const originFilterColumns = {
  originChannel: "origin->>'channel'", originIntegrationClientId: "origin->>'integrationClientId'",
  originClientId: "origin#>>'{client,id,value}'", originCallingAgentId: "origin#>>'{callingAgent,id,value}'",
} as const;
export function originCsv(origin: AuditOriginV1) {
  return { originVersion: origin.version, originChannel: origin.channel, originIntegrationClientId: origin.integrationClientId,
    originClientId: origin.client.id.value, originClientIdEvidence: origin.client.id.evidence,
    originClientName: origin.client.name.value, originClientNameEvidence: origin.client.name.evidence,
    originClientVersion: origin.client.version.value, originClientVersionEvidence: origin.client.version.evidence,
    originCallingAgentId: origin.callingAgent.id.value, originCallingAgentIdEvidence: origin.callingAgent.id.evidence,
    originCallingAgentName: origin.callingAgent.name.value, originCallingAgentNameEvidence: origin.callingAgent.name.evidence,
    originRequestId: origin.requestId, originMcpCallId: origin.mcpCallId };
}
