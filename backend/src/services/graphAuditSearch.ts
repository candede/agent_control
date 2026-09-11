import { isIP } from "node:net";
import { AppError } from "../errors.js";
import { boundedProviderText } from "./providerJson.js";
import {
  purviewAuditPresetIds,
  purviewAuditPresets,
  type PurviewAuditFilters,
  type PurviewAuditPresetId,
  type PurviewAuditRecord,
  type PurviewAuditResult,
  type PurviewAuditPartialReason,
  type PurviewProviderQuery,
  type PurviewProviderQueryStatus,
  type PurviewMessageReference,
} from "../types/purviewAudit.js";

const graphOrigin = "https://graph.microsoft.com";
const queryPath = "/v1.0/security/auditLog/queries";
const queryStatuses = new Set<PurviewProviderQueryStatus>(["notStarted", "running", "succeeded", "failed", "cancelled", "unknownFutureValue"]);
const queryKeys = new Set(["@odata.type", "id", "displayName", "filterStartDateTime", "filterEndDateTime", "serviceFilter", "recordTypeFilters", "operationFilters", "userPrincipalNameFilters", "ipAddressFilters", "objectIdFilters", "administrativeUnitIdFilters", "status"]);
const recordKeys = new Set(["@odata.type", "id", "createdDateTime", "auditLogRecordType", "operation", "organizationId", "userType", "userId", "service", "objectId", "userPrincipalName", "clientIp", "administrativeUnits", "auditData"]);
const auditDataKeys = new Set(["@odata.type", "dynamicProperties"]);
const dynamicPropertyKeys = new Set(["@odata.type", "ID", "CreationTime", "Operation", "OrganizationId", "RecordType", "ResultStatus", "UserId", "UserKey", "UserType", "Version", "Workload", "ClientIP", "ObjectId", "CorrelationId", "CopilotEventData", "BotId", "EnvironmentId", "BotComponentId", "AIPluginOperationId"]);
const copilotEventDataKeys = new Set(["AgentId", "AppIdentity", "AppHost", "Messages"]);
const nativeRecordTypes = new Map([
  ["powerPlatformAdministratorActivity", 256],
  ["copilotInteraction", 261],
]);
const defaultAuditDataType = "#microsoft.graph.security.defaultAuditData";
const auditDictionaryType = "#microsoft.graph.security.auditRecordTypeDictionary";
const auditLogRecordType = "#microsoft.graph.security.auditLogRecord";
const maximumResponseBytes = 2_000_000;
const maximumRequestBudgetMs = 30_000;
export const purviewMaximumResultBytes = 8_000_000;
export const purviewMaximumRecordPages = 20;
export const purviewMaximumRecords = 5_000;
export const purviewMaximumWindowMs = 7 * 24 * 60 * 60 * 1000;
export const purviewQualificationMaximumWindowMs = 60 * 60 * 1000;

type ClientDependencies = {
  fetch: typeof fetch;
  wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  random: () => number;
  now?: () => number;
  requestTimeoutMs?: number;
};

type ProviderRequestOptions = {
  signal?: AbortSignal;
  correlationId?: string;
  beforeRequest?: () => Promise<void>;
  onResponse?: (providerRequestId: string | null) => Promise<void>;
};

const defaultDependencies: ClientDependencies = {
  fetch,
  wait: (milliseconds, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  }),
  random: Math.random,
  now: Date.now,
};

export class GraphAuditSearchClient {
  constructor(private readonly dependencies: ClientDependencies = defaultDependencies) {}

  async createQuery(token: string, displayName: string, filters: PurviewAuditFilters, options: ProviderRequestOptions = {}) {
    const attempt = await this.request(token, `${graphOrigin}${queryPath}`, {
      method: "POST",
      body: JSON.stringify(createProviderQueryBody(displayName, filters)),
      signal: options.signal,
      correlationId: options.correlationId,
      beforeRequest: options.beforeRequest,
      onResponse: options.onResponse,
      retry: false,
      create: true,
    });
    const { response } = attempt;
    if (response.status !== 201) throw providerFailure(response);
    let value: unknown;
    try {
      value = await responseJson(response, attempt.signal);
    } catch (error) {
      if (isResponseConsumptionFailure(error)) throw new AppError(409, "audit_create_inconclusive", "The Audit Search create response was interrupted and must be reconciled before any new create.");
      throw error;
    }
    return parseDirectQuery(value, "create");
  }

  async getQuery(token: string, providerQueryId: string, options: ProviderRequestOptions = {}) {
    const attempt = await this.request(token, queryUrl(providerQueryId), { method: "GET", ...options, retry: true });
    const { response } = attempt;
    if (response.status !== 200) throw providerFailure(response);
    return parseDirectQuery(await responseJson(response, attempt.signal), "get");
  }

  async listQueries(token: string, options: ProviderRequestOptions & { maximumPages?: number } = {}) {
    const result: PurviewProviderQuery[] = [];
    const seen = new Set<string>();
    let next: string | null = `${graphOrigin}${queryPath}`;
    const maximumPages = Math.min(Math.max(options.maximumPages ?? 5, 1), 5);
    for (let page = 0; next && page < maximumPages; page += 1) {
      validateGraphUrl(next, queryPath, false);
      if (seen.has(next)) throw new AppError(502, "provider_schema", "Microsoft Graph repeated an Audit Search query page link.");
      seen.add(next);
      const attempt = await this.request(token, next, { method: "GET", signal: options.signal, correlationId: options.correlationId,
        beforeRequest: options.beforeRequest, onResponse: options.onResponse, retry: true });
      const { response } = attempt;
      if (response.status !== 200) throw providerFailure(response);
      const envelope = parseCollection(await responseJson(response, attempt.signal), "query");
      result.push(...envelope.value.map(value => parseDirectQuery(value, "list")));
      next = envelope.nextLink;
    }
    return { value: result, complete: next === null, nextLink: next };
  }

  async listRecords(token: string, providerQueryId: string, expectedTenantId: string, options: ProviderRequestOptions & { startUrl?: string } = {}): Promise<PurviewAuditResult> {
    const records: PurviewAuditRecord[] = [];
    const nativeIds = new Map<string, string>();
    const wrapperIds = new Map<string, string>();
    const seenPages = new Set<string>();
    let next: string | null = options.startUrl ?? `${queryUrl(providerQueryId)}/records`;
    let pageCount = 0;
    let providerRowCount = 0;
    let byteCount = 0;
    let unknownFieldCount = 0;
    while (next && pageCount < purviewMaximumRecordPages && providerRowCount < purviewMaximumRecords && byteCount < purviewMaximumResultBytes) {
      validateGraphUrl(next, `${queryPath}/${encodeURIComponent(providerQueryId)}/records`, false);
      if (seenPages.has(next)) throw new AppError(502, "provider_schema", "Microsoft Graph repeated an Audit Search records page link.");
      seenPages.add(next);
      let text: string;
      try {
        const attempt = await this.request(token, next, { method: "GET", signal: options.signal, correlationId: options.correlationId,
          beforeRequest: options.beforeRequest, onResponse: options.onResponse, retry: true });
        const { response } = attempt;
        if (response.status !== 200) throw providerFailure(response);
        text = await boundedProviderText(response, maximumResponseBytes, attempt.signal);
      } catch (error) {
        const partialReason = safePartialPageReason(error);
        if (pageCount > 0 && partialReason) return finishResult(records, pageCount, providerRowCount, byteCount, unknownFieldCount, false, next, partialReason);
        throw error;
      }
      byteCount += Buffer.byteLength(text);
      if (byteCount > purviewMaximumResultBytes) {
        return finishResult(records, pageCount, providerRowCount, byteCount, unknownFieldCount, false, next, "audit_byte_limit");
      }
      const envelope = parseCollection(parseJson(text), "record");
      pageCount += 1;
      for (const value of envelope.value) {
        providerRowCount += 1;
        if (providerRowCount > purviewMaximumRecords) return finishResult(records, pageCount, providerRowCount, byteCount, unknownFieldCount, false, next, "audit_row_limit");
        const record = parseAuditRecord(value, expectedTenantId);
        unknownFieldCount += record.unknownFieldCount;
        const fingerprint = JSON.stringify(record);
        const previousWrapper = wrapperIds.get(record.wrapperId);
        if (previousWrapper !== undefined) {
          if (previousWrapper !== fingerprint) throw new AppError(502, "provider_schema", "Microsoft Graph returned conflicting rows for one audit wrapper ID.");
          continue;
        }
        wrapperIds.set(record.wrapperId, fingerprint);
        if (record.nativeEventId) {
          const nativeFingerprint = nativeRecordFingerprint(record);
          const previousNative = nativeIds.get(record.nativeEventId);
          if (previousNative !== undefined) {
            if (previousNative !== nativeFingerprint) throw new AppError(502, "provider_schema", "Microsoft Graph returned conflicting rows for one native audit event ID.");
            continue;
          }
          nativeIds.set(record.nativeEventId, nativeFingerprint);
        }
        records.push(record);
      }
      next = envelope.nextLink;
    }
    return finishResult(records, pageCount, providerRowCount, byteCount, unknownFieldCount, next === null, next, next === null ? null : "audit_page_limit");
  }

  private async request(token: string, url: string, options: ProviderRequestOptions & { method: "GET" | "POST"; body?: string; retry: boolean; create?: boolean }) {
    validateGraphUrl(url, queryPath);
    const maximumAttempts = options.retry ? 3 : 1;
    const startedAt = this.now();
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      const remainingBudget = maximumRequestBudgetMs - (this.now() - startedAt);
      if (remainingBudget <= 0) throw new AppError(502, "provider_error", "Microsoft Graph Audit Search exhausted its request time budget.");
      const timeout = AbortSignal.timeout(Math.max(1, Math.min(this.dependencies.requestTimeoutMs ?? 10_000, remainingBudget)));
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      try {
        if (signal.aborted) throw signal.reason;
        await options.beforeRequest?.();
        if (signal.aborted) throw signal.reason;
        const response = await this.dependencies.fetch(url, {
          method: options.method,
          redirect: "manual",
          signal,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            ...(options.body ? { "Content-Type": "application/json" } : {}),
            ...(options.correlationId ? { "client-request-id": options.correlationId, "return-client-request-id": "true" } : {}),
          },
          body: options.body,
        });
        try {
          await options.onResponse?.(responseRequestId(response));
        } catch (error) {
          await cancelResponse(response);
          throw error;
        }
        if (isRedirect(response.status)) throw new AppError(502, "invalid_provider_link", "Microsoft Graph returned an unexpected redirect.");
        if (attempt < maximumAttempts && (response.status === 429 || response.status >= 500)) {
          const delay = retryDelay(response.headers.get("retry-after"), response.headers.get("date"), attempt, this.dependencies.random());
          if (delay >= maximumRequestBudgetMs - (this.now() - startedAt)) {
            await cancelResponse(response);
            return { response, signal };
          }
          await cancelResponse(response);
          await this.dependencies.wait(delay, options.signal);
          continue;
        }
        return { response, signal };
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason;
        if (signal.aborted) {
          if (options.create) throw new AppError(409, "audit_create_inconclusive", "The Audit Search create outcome is unknown and must be reconciled before any new create.");
          throw new AppError(502, "provider_error", "Microsoft Graph Audit Search exhausted its request time budget.");
        }
        if (error instanceof AppError) throw error;
        if (options.create) throw new AppError(409, "audit_create_inconclusive", "The Audit Search create outcome is unknown and must be reconciled before any new create.");
        if (attempt === maximumAttempts) throw new AppError(502, "provider_error", "Microsoft Graph Audit Search failed within its bounded network retry budget.");
        const delay = retryDelay(null, null, attempt, this.dependencies.random());
        if (delay >= maximumRequestBudgetMs - (this.now() - startedAt)) {
          throw new AppError(502, "provider_error", "Microsoft Graph Audit Search exhausted its request time budget before retry.");
        }
        await this.dependencies.wait(delay, options.signal);
      }
    }
    throw new AppError(502, "provider_error", "Microsoft Graph Audit Search request failed.");
  }

  private now() {
    return this.dependencies.now?.() ?? Date.now();
  }
}

export function validatePurviewAuditFilters(value: unknown, options: { now?: Date; qualification?: boolean } = {}): PurviewAuditFilters {
  if (!isObject(value)) throw new AppError(400, "invalid_audit_filters", "Audit Search filters must be a structured object.");
  const allowed = new Set(["presetId", "operations", "startDateTime", "endDateTime", "userPrincipalNames", "ipAddresses", "objectIds", "administrativeUnitIds"]);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new AppError(400, "invalid_audit_filters", "Audit Search filters contain an unsupported field.");
  const presetId = value.presetId;
  if (typeof presetId !== "string" || !purviewAuditPresetIds.includes(presetId as PurviewAuditPresetId)) throw new AppError(400, "invalid_audit_filters", "Select a supported code-owned Audit Search preset.");
  const startDateTime = utcInstant(value.startDateTime, "start");
  const endDateTime = utcInstant(value.endDateTime, "end");
  const start = Date.parse(startDateTime);
  const end = Date.parse(endDateTime);
  const now = (options.now ?? new Date()).getTime();
  const maximumWindow = options.qualification ? purviewQualificationMaximumWindowMs : purviewMaximumWindowMs;
  if (end <= start || end - start > maximumWindow || end > now + 5 * 60 * 1000 || start < now - purviewMaximumWindowMs) {
    throw new AppError(400, "invalid_audit_range", `Audit Search requires a recent UTC range no longer than ${maximumWindow / 3_600_000} hour(s).`);
  }
  const preset = purviewAuditPresets[presetId as PurviewAuditPresetId];
  const operations = stringList(value.operations, "operations", item => preset.operationFilters.includes(item), 256, 100);
  if (!operations.length) throw new AppError(400, "invalid_audit_filters", "Select at least one supported Audit Search operation.");
  return {
    presetId: presetId as PurviewAuditPresetId,
    operations,
    startDateTime,
    endDateTime,
    userPrincipalNames: stringList(value.userPrincipalNames, "userPrincipalNames", item => item.includes("@")),
    ipAddresses: stringList(value.ipAddresses, "ipAddresses", item => isIP(item) !== 0),
    objectIds: stringList(value.objectIds, "objectIds", () => true, 512),
    administrativeUnitIds: stringList(value.administrativeUnitIds, "administrativeUnitIds", item => uuid(item)),
  };
}

export function createProviderQueryBody(displayName: string, filters: PurviewAuditFilters) {
  if (!/^agent-control-audit:[a-f0-9-]{36}$/i.test(displayName)) throw new AppError(400, "invalid_audit_marker", "Audit Search requires a code-owned operation marker.");
  const preset = purviewAuditPresets[filters.presetId];
  return {
    displayName,
    filterStartDateTime: filters.startDateTime,
    filterEndDateTime: filters.endDateTime,
    recordTypeFilters: [...preset.recordTypeFilters],
    serviceFilter: preset.serviceFilter,
    operationFilters: [...filters.operations],
    userPrincipalNameFilters: [...filters.userPrincipalNames],
    ipAddressFilters: [...filters.ipAddresses],
    objectIdFilters: [...filters.objectIds],
    administrativeUnitIdFilters: [...filters.administrativeUnitIds],
  };
}

export function providerQueryMatches(query: PurviewProviderQuery, displayName: string, filters: PurviewAuditFilters) {
  const expected = createProviderQueryBody(displayName, filters);
  return query.displayName === expected.displayName
    && query.filterStartDateTime === expected.filterStartDateTime
    && query.filterEndDateTime === expected.filterEndDateTime
    && query.serviceFilter === expected.serviceFilter
    && unorderedArraysEqual(query.recordTypeFilters, expected.recordTypeFilters)
    && unorderedArraysEqual(query.operationFilters, expected.operationFilters)
    && unorderedArraysEqual(query.userPrincipalNameFilters, expected.userPrincipalNameFilters)
    && unorderedArraysEqual(query.ipAddressFilters, expected.ipAddressFilters)
    && unorderedArraysEqual(query.objectIdFilters, expected.objectIdFilters)
    && unorderedArraysEqual(query.administrativeUnitIdFilters, expected.administrativeUnitIdFilters);
}

function parseDirectQuery(value: unknown, operation: "create" | "get" | "list"): PurviewProviderQuery {
  if (!isObject(value) || "value" in value) throw new AppError(502, "provider_schema", `Microsoft Graph returned an unsupported ${operation} Audit Search query shape.`);
  if (Object.keys(value).some(key => !queryKeys.has(key))) throw new AppError(502, "provider_schema", "Microsoft Graph returned unknown Audit Search query fields.");
  const status = boundedString(value.status, "status", 64) as PurviewProviderQueryStatus;
  if (!queryStatuses.has(status)) throw new AppError(502, "provider_schema", "Microsoft Graph returned an invalid Audit Search query status.");
  return {
    id: boundedString(value.id, "id", 512),
    displayName: boundedString(value.displayName, "displayName", 256),
    filterStartDateTime: utcInstant(value.filterStartDateTime, "filterStartDateTime"),
    filterEndDateTime: utcInstant(value.filterEndDateTime, "filterEndDateTime"),
    serviceFilter: boundedString(value.serviceFilter, "serviceFilter", 128),
    recordTypeFilters: responseStringList(value.recordTypeFilters, "recordTypeFilters"),
    operationFilters: responseStringList(value.operationFilters, "operationFilters", 100),
    userPrincipalNameFilters: responseStringList(value.userPrincipalNameFilters, "userPrincipalNameFilters"),
    ipAddressFilters: responseStringList(value.ipAddressFilters, "ipAddressFilters"),
    objectIdFilters: responseStringList(value.objectIdFilters, "objectIdFilters"),
    administrativeUnitIdFilters: responseStringList(value.administrativeUnitIdFilters, "administrativeUnitIdFilters"),
    status,
  };
}

function parseAuditRecord(value: unknown, expectedTenantId: string): PurviewAuditRecord {
  if (!isObject(value)) throw new AppError(502, "provider_schema", "Microsoft Graph returned a malformed Audit Search record.");
  if (value["@odata.type"] !== auditLogRecordType) throw new AppError(502, "provider_schema", "Microsoft Graph Audit Search records must use the selected auditLogRecord type.");
  const unknownWrapper = Object.keys(value).filter(key => !recordKeys.has(key)).length;
  const auditData = value.auditData;
  if (!isObject(auditData) || auditData["@odata.type"] !== defaultAuditDataType) throw new AppError(502, "provider_schema", "Microsoft Graph Audit Search auditData must use the selected defaultAuditData type.");
  const dynamicProperties = requireObject(auditData.dynamicProperties, "auditData.dynamicProperties");
  if (dynamicProperties["@odata.type"] !== auditDictionaryType) throw new AppError(502, "provider_schema", "Microsoft Graph Audit Search dynamicProperties must use the selected dictionary type.");
  const wrapperRecordType = boundedString(value.auditLogRecordType, "auditLogRecordType", 128);
  const nativeRecordType = optionalInteger(dynamicProperties.RecordType, 0, 2_147_483_647);
  const expectedNativeRecordType = nativeRecordTypes.get(wrapperRecordType);
  if (expectedNativeRecordType === undefined || nativeRecordType !== null && nativeRecordType !== expectedNativeRecordType) {
    throw new AppError(502, "provider_schema", "Microsoft Graph returned an unsupported native audit record type.");
  }
  optionalInteger(dynamicProperties.UserType, 0, 10);
  optionalInteger(dynamicProperties.Version, 1, 2_147_483_647);
  const wrapperTenant = boundedString(value.organizationId, "organizationId", 128);
  const auditTenant = optionalString(dynamicProperties.OrganizationId, 128);
  if (wrapperTenant !== expectedTenantId || auditTenant && auditTenant !== expectedTenantId) throw new AppError(403, "scope_mismatch", "Microsoft Graph returned an audit record for another tenant.");
  const unknownAuditData = Object.keys(auditData).filter(key => !auditDataKeys.has(key)).length;
  const unknownDynamicProperties = Object.keys(dynamicProperties).filter(key => !dynamicPropertyKeys.has(key)).length;
  const copilotEventData = optionalObject(dynamicProperties.CopilotEventData, "auditData.dynamicProperties.CopilotEventData");
  const unknownCopilotEventData = copilotEventData === null ? 0 : Object.keys(copilotEventData).filter(key => !copilotEventDataKeys.has(key)).length;
  const messagesValue = copilotEventData?.Messages;
  const messages = parseMessages(messagesValue);
  const nativeEventId = optionalString(dynamicProperties.ID, 128);
  if (nativeEventId !== null && !uuid(nativeEventId)) throw new AppError(502, "provider_schema", "Microsoft Graph returned a malformed native audit event ID.");
  return {
    projectionVersion: 1,
    wrapperId: boundedString(value.id, "id", 512),
    nativeEventId,
    eventDateTime: utcInstant(value.createdDateTime, "createdDateTime"),
    auditLogRecordType: wrapperRecordType,
    operation: boundedString(value.operation, "operation", 256),
    service: boundedString(value.service, "service", 128),
    resultStatus: optionalString(dynamicProperties.ResultStatus, 128),
    actorUserId: optionalString(value.userId, 512) ?? optionalString(dynamicProperties.UserId, 512) ?? optionalString(dynamicProperties.UserKey, 512),
    actorUserPrincipalName: optionalString(value.userPrincipalName, 512),
    actorUserType: optionalString(value.userType, 128),
    objectId: optionalString(value.objectId, 1024) ?? optionalString(dynamicProperties.ObjectId, 1024),
    clientIp: optionalString(value.clientIp, 128) ?? optionalString(dynamicProperties.ClientIP, 128),
    administrativeUnits: responseStringList(value.administrativeUnits, "administrativeUnits"),
    correlationId: optionalString(dynamicProperties.CorrelationId, 256),
    agentId: optionalString(copilotEventData?.AgentId, 512),
    appIdentity: optionalString(copilotEventData?.AppIdentity, 512),
    appHost: optionalString(copilotEventData?.AppHost, 256),
    botId: optionalString(dynamicProperties.BotId, 512),
    environmentId: optionalString(dynamicProperties.EnvironmentId, 512),
    botComponentId: optionalString(dynamicProperties.BotComponentId, 512),
    aiPluginOperationId: optionalString(dynamicProperties.AIPluginOperationId, 512),
    messages,
    contentAvailable: false,
    unknownFieldCount: unknownWrapper + unknownAuditData + unknownDynamicProperties + unknownCopilotEventData + messageUnknownCount(messagesValue),
  };
}

function parseMessages(value: unknown): PurviewMessageReference[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 100) throw new AppError(502, "provider_schema", "Microsoft Graph returned malformed Copilot message references.");
  return value.map(item => {
    if (!isObject(item)) throw new AppError(502, "provider_schema", "Microsoft Graph returned a malformed Copilot message reference.");
    const id = optionalString(item.ID, 512);
    const isPrompt = item.isPrompt;
    if (!id || typeof isPrompt !== "boolean") throw new AppError(502, "provider_schema", "Microsoft Graph returned a malformed Copilot message reference.");
    return { id, isPrompt };
  });
}

function messageUnknownCount(value: unknown) {
  if (!Array.isArray(value)) return 0;
  return value.reduce((count, item) => count + (isObject(item) ? Object.keys(item).filter(key => !["ID", "isPrompt"].includes(key)).length : 0), 0);
}

function parseCollection(value: unknown, kind: "query" | "record") {
  if (!isObject(value) || !Array.isArray(value.value)) throw new AppError(502, "provider_schema", `Microsoft Graph returned an unsupported Audit Search ${kind} collection shape.`);
  const allowed = new Set(["@odata.context", "@odata.count", "@odata.nextLink", "value"]);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new AppError(502, "provider_schema", "Microsoft Graph returned unknown collection envelope fields.");
  if (value.value.length > purviewMaximumRecords) throw new AppError(502, "provider_result_limit", "Microsoft Graph returned too many Audit Search rows in one page.");
  const nextLink = value["@odata.nextLink"];
  if (nextLink !== undefined && (typeof nextLink !== "string" || nextLink.length > 4096)) throw new AppError(502, "provider_schema", "Microsoft Graph returned an invalid Audit Search next link.");
  return { value: value.value, nextLink: nextLink ?? null as string | null };
}

async function responseJson(response: Response, signal?: AbortSignal) {
  try {
    return parseJson(await boundedProviderText(response, maximumResponseBytes, signal));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(502, "provider_error", "Microsoft Graph Audit Search response consumption failed within its attempt deadline.");
  }
}

function parseJson(text: string) {
  try { return JSON.parse(text) as unknown; }
  catch { throw new AppError(502, "provider_schema", "Microsoft Graph returned invalid JSON."); }
}

function finishResult(records: PurviewAuditRecord[], pageCount: number, providerRowCount: number, byteCount: number, unknownFieldCount: number, complete: boolean, nextLink: string | null, partialReason: PurviewAuditPartialReason | null): PurviewAuditResult {
  return { records, pageCount, providerRowCount, storedRowCount: records.length, byteCount, unknownFieldCount, complete, nextLink, partialReason };
}

function queryUrl(id: string) {
  if (!id || id.length > 512 || /[/?#\\\0]/.test(id)) throw new AppError(400, "invalid_provider_query_id", "Audit Search provider query ID is invalid.");
  return `${graphOrigin}${queryPath}/${encodeURIComponent(id)}`;
}

function validateGraphUrl(value: string, expectedPath: string, allowDescendants = true) {
  const url = new URL(value);
  const validPath = url.pathname === expectedPath || allowDescendants && url.pathname.startsWith(`${expectedPath}/`);
  if (url.origin !== graphOrigin || url.username || url.password || url.hash || !validPath) throw new AppError(502, "invalid_provider_link", "Audit Search provider link is outside the selected Graph v1.0 contract.");
}

function retryDelay(retryAfter: string | null, responseDate: string | null, attempt: number, random: number) {
  if (retryAfter && /^\d+$/.test(retryAfter)) return Math.min(Number(retryAfter) * 1000, 30_000);
  if (retryAfter) {
    const retryAt = Date.parse(retryAfter);
    const responseAt = responseDate === null ? Date.now() : Date.parse(responseDate);
    if (Number.isFinite(retryAt) && Number.isFinite(responseAt)) return Math.min(Math.max(retryAt - responseAt, 0), 30_000);
  }
  return Math.min(250 * 2 ** (attempt - 1) + Math.floor(random * 250), 5_000);
}

async function cancelResponse(response: Response) {
  try { await response.body?.cancel(); }
  catch { /* Retry remains bounded even when the provider body cannot be cancelled. */ }
}

function responseRequestId(response: Response) {
  const value = response.headers.get("request-id");
  return value && value.length <= 256 && !/[\r\n\0]/.test(value) ? value : null;
}

function safePartialPageReason(error: unknown): PurviewAuditPartialReason | null {
  if (error instanceof AppError && ["provider_throttled", "provider_error", "provider_result_limit", "audit_provider_request_limit", "audit_job_expired"].includes(error.code)) {
    return error.code as PurviewAuditPartialReason;
  }
  if (error instanceof DOMException && error.name === "TimeoutError") return "audit_activation_timeout";
  if (error instanceof TypeError) return "provider_error";
  return null;
}

function isResponseConsumptionFailure(error: unknown) {
  return error instanceof TypeError || error instanceof DOMException
    || error instanceof AppError && ["provider_error", "provider_result_limit"].includes(error.code);
}

function nativeRecordFingerprint(record: PurviewAuditRecord) {
  const { wrapperId: _wrapperId, ...nativeRecord } = record;
  return JSON.stringify(nativeRecord);
}

function providerFailure(response: Response) {
  if (response.status === 401) return new AppError(401, "authorization_expired", "Microsoft Graph Audit Search authorization expired.");
  if (response.status === 403) return new AppError(403, "provider_denied", "Microsoft Graph denied Audit Search without identifying a permission, Purview role, license, or tenant-support cause.");
  if (response.status === 429) return new AppError(429, "provider_throttled", "Microsoft Graph throttled Audit Search within its bounded retry budget.");
  return new AppError(502, "provider_error", `Microsoft Graph Audit Search returned status ${response.status}.`);
}

function utcInstant(value: unknown, field: string) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new AppError(400, "invalid_audit_range", `Audit Search ${field} must be an exact UTC timestamp.`);
  const instant = new Date(value).toISOString();
  const normalizedInput = value.includes(".") ? value : value.replace("Z", ".000Z");
  if (instant !== normalizedInput) throw new AppError(400, "invalid_audit_range", `Audit Search ${field} must be an exact UTC timestamp.`);
  return instant;
}

function stringList(value: unknown, field: string, validate: (item: string) => boolean, maximumLength = 256, maximumItems = 20) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximumItems || value.some(item => typeof item !== "string" || !item || item.length > maximumLength || /[\r\n\0]/.test(item) || !validate(item))) throw new AppError(400, "invalid_audit_filters", `Audit Search ${field} is invalid.`);
  if (new Set(value).size !== value.length) throw new AppError(400, "invalid_audit_filters", `Audit Search ${field} contains duplicates.`);
  return [...value].sort(ordinal);
}

function responseStringList(value: unknown, field: string, maximum = 20) {
  if (!Array.isArray(value) || value.length > maximum || value.some(item => typeof item !== "string" || !item || item.length > 512)) throw new AppError(502, "provider_schema", `Microsoft Graph returned an invalid ${field}.`);
  return [...value] as string[];
}

function boundedString(value: unknown, field: string, maximum: number) {
  if (typeof value !== "string" || !value || value.length > maximum || /[\r\n\0]/.test(value)) throw new AppError(502, "provider_schema", `Microsoft Graph returned an invalid ${field}.`);
  return value;
}

function optionalString(value: unknown, maximum: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > maximum || /[\r\n\0]/.test(value)) throw new AppError(502, "provider_schema", "Microsoft Graph returned malformed typed audit metadata.");
  return value;
}

function optionalInteger(value: unknown, minimum: number, maximum: number): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new AppError(502, "provider_schema", "Microsoft Graph returned malformed typed audit metadata.");
  return value as number;
}

function requireObject(value: unknown, field: string) {
  if (!isObject(value)) throw new AppError(502, "provider_schema", `Microsoft Graph returned malformed ${field} metadata.`);
  return value;
}

function optionalObject(value: unknown, field: string): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  return requireObject(value, field);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function uuid(value: string) {
  return /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
}

function unorderedArraysEqual(left: readonly string[], right: readonly string[]) {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort(ordinal);
  const sortedRight = [...right].sort(ordinal);
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function isRedirect(status: number) {
  return status >= 300 && status < 400;
}

function ordinal(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}