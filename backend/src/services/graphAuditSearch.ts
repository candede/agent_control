import { isIP } from "node:net";
import { AppError } from "../errors.js";
import { boundedProviderJson, boundedProviderText, parseProviderContractJson } from "./providerJson.js";
import {
  purviewAuditPresetIds,
  purviewAuditPresets,
  type PurviewAuditFilters,
  type PurviewAuditAgentTarget,
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
const queryKeys = new Set(["@odata.type", "@odata.context", "id", "displayName", "filterStartDateTime", "filterEndDateTime", "serviceFilter", "serviceFilters", "recordTypeFilters", "operationFilters", "userPrincipalNameFilters", "ipAddressFilters", "objectIdFilters", "administrativeUnitIdFilters", "keywordFilter", "status", "approximateReturnedRecordCount", "recordCountLimit", "isRecordCountLimitExceeded"]);
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
  assertCurrent?: () => void;
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
      assertCurrent: options.assertCurrent,
      beforeRequest: options.beforeRequest,
      onResponse: options.onResponse,
      retry: false,
      create: true,
    });
    const { response } = attempt;
    if (response.status !== 201) throw providerFailure(response, this.now());
    let value: unknown;
    try {
      value = await responseJson(response, attempt.signal, options.signal, options.assertCurrent);
      if (attempt.signal.aborted) throw responseConsumptionError(attempt.signal.reason, options.signal);
    } catch (error) {
      if (isResponseConsumptionFailure(error)) throw new AppError(409, "audit_create_inconclusive", "The Audit Search create response was interrupted and must be reconciled before any new create.", responseDetails(response, this.now()));
      throw error;
    }
    const query = parseDirectQuery(value, "create");
    options.assertCurrent?.();
    return query;
  }

  async getQuery(token: string, providerQueryId: string, options: ProviderRequestOptions = {}) {
    const attempt = await this.request(token, queryUrl(providerQueryId), { method: "GET", ...options, retry: true });
    const { response } = attempt;
    if (response.status !== 200) throw providerFailure(response, this.now());
    const value = await responseJson(response, attempt.signal, options.signal, options.assertCurrent);
    if (attempt.signal.aborted) throw responseConsumptionError(attempt.signal.reason, options.signal);
    const query = parseDirectQuery(value, "get");
    options.assertCurrent?.();
    return query;
  }

  async listQueries(token: string, options: ProviderRequestOptions & { maximumPages?: number } = {}) {
    const result: PurviewProviderQuery[] = [];
    const seen = new Set<string>();
    let next: string | null = `${graphOrigin}${queryPath}`;
    const maximumPages = Math.min(Math.max(options.maximumPages ?? 5, 1), 5);
    for (let page = 0; next && page < maximumPages; page += 1) {
      validateGraphUrl(next, queryPath, false);
      if (seen.has(pageIdentity(next))) throw new AppError(502, "provider_schema", "Microsoft Graph repeated an Audit Search query page link.");
      seen.add(pageIdentity(next));
      const attempt = await this.request(token, next, { method: "GET", signal: options.signal, correlationId: options.correlationId,
        assertCurrent: options.assertCurrent, beforeRequest: options.beforeRequest, onResponse: options.onResponse, retry: true });
      const { response } = attempt;
      if (response.status !== 200) throw providerFailure(response, this.now());
      const value = await responseJson(response, attempt.signal, options.signal, options.assertCurrent);
      if (attempt.signal.aborted) throw responseConsumptionError(attempt.signal.reason, options.signal);
      const envelope = parseCollection(value, "query");
      validateNextLink(envelope.nextLink, queryPath, seen);
      result.push(...envelope.value.map(value => parseDirectQuery(value, "list")));
      next = envelope.nextLink;
    }
    options.signal?.throwIfAborted();
    options.assertCurrent?.();
    return { value: result, complete: next === null, nextLink: next };
  }

  async listRecords(token: string, providerQueryId: string, expectedTenantId: string, options: ProviderRequestOptions & { startUrl?: string } = {}): Promise<PurviewAuditResult> {
    const records: PurviewAuditRecord[] = [];
    const nativeIds = new Map<string, string>();
    const wrapperIds = new Map<string, string>();
    const seenPages = new Set<string>();
    let next: string | null = options.startUrl ?? `${queryUrl(providerQueryId)}/records`;
    const recordsPath = `${queryPath}/${encodeURIComponent(providerQueryId)}/records`;
    validateGraphUrl(next, recordsPath, false);
    let pageCount = 0;
    let providerRowCount = 0;
    let byteCount = 0;
    let unknownFieldCount = 0;
    while (next && pageCount < purviewMaximumRecordPages && providerRowCount < purviewMaximumRecords && byteCount < purviewMaximumResultBytes) {
      validateGraphUrl(next, recordsPath, false);
      if (seenPages.has(pageIdentity(next))) throw new AppError(502, "provider_schema", "Microsoft Graph repeated an Audit Search records page link.");
      seenPages.add(pageIdentity(next));
      let text: string;
      let response: Response | undefined;
      try {
        const attempt = await this.request(token, next, { method: "GET", signal: options.signal, correlationId: options.correlationId,
          assertCurrent: options.assertCurrent, beforeRequest: options.beforeRequest, onResponse: options.onResponse, retry: true });
        response = attempt.response;
        if (response.status !== 200) throw providerFailure(response, this.now());
        text = await awaitCurrent(() => boundedProviderText(attempt.response, maximumResponseBytes, attempt.signal), attempt.signal, options.assertCurrent);
        attempt.signal.throwIfAborted();
      } catch (error) {
        if (response) cancelResponse(response);
        options.assertCurrent?.();
        const failure = responseConsumptionError(error, options.signal, response);
        const partialReason = safePartialPageReason(failure);
        if (pageCount > 0 && partialReason) return finishResult(records, pageCount, providerRowCount, byteCount, unknownFieldCount, false, next, partialReason);
        throw failure;
      }
      byteCount += Buffer.byteLength(text);
      const envelope = parseCollection(parseJson(text), "record");
      validateNextLink(envelope.nextLink, recordsPath, seenPages);
      if (byteCount > purviewMaximumResultBytes) {
        return finishResult(records, pageCount, providerRowCount, byteCount, unknownFieldCount, false, next, "audit_byte_limit");
      }
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
    const partialReason = next === null ? null
      : providerRowCount >= purviewMaximumRecords ? "audit_row_limit"
        : byteCount >= purviewMaximumResultBytes ? "audit_byte_limit" : "audit_page_limit";
    options.signal?.throwIfAborted();
    options.assertCurrent?.();
    return finishResult(records, pageCount, providerRowCount, byteCount, unknownFieldCount, next === null, next, partialReason);
  }

  private async request(token: string, url: string, options: ProviderRequestOptions & { method: "GET" | "POST"; body?: string; retry: boolean; create?: boolean }) {
    validateGraphUrl(url, queryPath);
    const maximumAttempts = options.retry ? 3 : 1;
    const startedAt = this.now();
    const deadline = AbortSignal.timeout(maximumRequestBudgetMs);
    const logicalSignal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    let received: Response | undefined;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      options.signal?.throwIfAborted();
      options.assertCurrent?.();
      const remainingBudget = maximumRequestBudgetMs - (this.now() - startedAt);
      if (remainingBudget <= 0) throw new AppError(502, "provider_error", "Microsoft Graph Audit Search exhausted its request time budget.");
      const timeout = AbortSignal.timeout(Math.max(1, Math.min(this.dependencies.requestTimeoutMs ?? 10_000, remainingBudget)));
      const signal = AbortSignal.any([logicalSignal, timeout]);
      let undeliveredResponse: Response | undefined;
      try {
        if (signal.aborted) throw signal.reason;
        await requestCallback(() => options.beforeRequest?.(), signal, options.assertCurrent);
        if (signal.aborted) throw signal.reason;
        options.assertCurrent?.();
        const fetching = this.dependencies.fetch(url, {
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
        void fetching.then(response => {
          if (signal.aborted) cancelResponse(response);
          else undeliveredResponse = response;
        }, () => undefined);
        const response = await awaitCurrent(() => fetching, signal);
        undeliveredResponse = undefined;
        received = response;
        try {
          options.assertCurrent?.();
          await requestCallback(() => options.onResponse?.(responseRequestId(response)), signal, options.assertCurrent);
        } catch (error) {
          cancelResponse(response);
          throw error;
        }
        if (isRedirect(response.status)) {
          cancelResponse(response);
          throw new AppError(502, "invalid_provider_link", "Microsoft Graph returned an unexpected redirect.", responseDetails(response, this.now()));
        }
        if (attempt < maximumAttempts && [429, 500, 502, 503, 504].includes(response.status)) {
          const delay = retryDelay(response.headers.get("retry-after"), response.headers.get("date"), attempt, this.dependencies.random(), this.now());
          if (delay >= maximumRequestBudgetMs - (this.now() - startedAt)) {
            cancelResponse(response);
            return { response, signal };
          }
          cancelResponse(response);
          await this.waitForRetry(delay, logicalSignal, options, response);
          continue;
        }
        if (response.status !== (options.create ? 201 : 200)) cancelResponse(response);
        return { response, signal };
      } catch (error) {
        if (undeliveredResponse) {
          received = undeliveredResponse;
          cancelResponse(undeliveredResponse);
        }
        if (options.signal?.aborted) throw options.signal.reason;
        options.assertCurrent?.();
        if (error instanceof AppError) throw error;
        if (signal.aborted) {
          if (received && !received.ok) throw providerFailure(received, this.now());
          if (options.create) throw new AppError(409, "audit_create_inconclusive", "The Audit Search create outcome is unknown and must be reconciled before any new create.", received && responseDetails(received, this.now()));
          throw new AppError(502, "provider_error", "Microsoft Graph Audit Search exhausted its request time budget.");
        }
        if (options.create) throw new AppError(409, "audit_create_inconclusive", "The Audit Search create outcome is unknown and must be reconciled before any new create.");
        if (attempt === maximumAttempts) throw new AppError(502, "provider_error", "Microsoft Graph Audit Search failed within its bounded network retry budget.");
        const delay = retryDelay(null, null, attempt, this.dependencies.random());
        if (delay >= maximumRequestBudgetMs - (this.now() - startedAt)) {
          throw new AppError(502, "provider_error", "Microsoft Graph Audit Search exhausted its request time budget before retry.");
        }
        await this.waitForRetry(delay, logicalSignal, options);
      }
    }
    throw new AppError(502, "provider_error", "Microsoft Graph Audit Search request failed.");
  }

  private now() {
    return this.dependencies.now?.() ?? Date.now();
  }

  private async waitForRetry(delay: number, signal: AbortSignal, options: ProviderRequestOptions, response?: Response) {
    try {
      await awaitCurrent(() => this.dependencies.wait(delay, options.signal), signal, options.assertCurrent);
    } catch (error) {
      options.signal?.throwIfAborted();
      options.assertCurrent?.();
      if (signal.aborted) throw response ? providerFailure(response, this.now())
        : new AppError(502, "provider_error", "Microsoft Graph Audit Search exhausted its request time budget.");
      if (error instanceof AppError) throw error;
      throw new AppError(500, "internal_error", "Audit Search retry scheduling failed.");
    }
  }
}

export function validatePurviewAuditFilters(value: unknown, options: { now?: Date; qualification?: boolean } = {}): PurviewAuditFilters {
  if (!isObject(value)) throw new AppError(400, "invalid_audit_filters", "Audit Search filters must be a structured object.");
  const allowed = new Set(["presetId", "operations", "startDateTime", "endDateTime", "userPrincipalNames", "ipAddresses", "objectIds", "administrativeUnitIds", "agent"]);
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
  const agent = value.agent === undefined ? undefined : validateAuditAgentTarget(value.agent);
  if (agent && presetId === "copilot_interactions" && !agent.applicationId) {
    throw new AppError(409, "agent_investigation_unavailable", "Copilot interaction search requires this agent's verified application identity.");
  }
  return {
    presetId: presetId as PurviewAuditPresetId,
    operations,
    startDateTime,
    endDateTime,
    userPrincipalNames: stringList(value.userPrincipalNames, "userPrincipalNames", item => item.includes("@") && !/\s/.test(item), 320),
    ipAddresses: stringList(value.ipAddresses, "ipAddresses", item => isIP(item) !== 0),
    objectIds: stringList(value.objectIds, "objectIds", () => true, 512),
    administrativeUnitIds: stringList(value.administrativeUnitIds, "administrativeUnitIds", item => uuid(item)),
    ...(agent ? { agent } : {}),
  };
}

function validateAuditAgentTarget(value: unknown): PurviewAuditAgentTarget {
  if (!isObject(value) || Object.keys(value).some(key => !["recordId", "botId", "environmentId", "applicationId"].includes(key))
    || typeof value.recordId !== "string" || !value.recordId || value.recordId.length > 2048
    || typeof value.botId !== "string" || !uuid(value.botId)
    || typeof value.environmentId !== "string" || !value.environmentId || value.environmentId.length > 256 || /[\s\0]/.test(value.environmentId)
    || value.applicationId !== undefined && (typeof value.applicationId !== "string" || !uuid(value.applicationId))) {
    throw new AppError(400, "invalid_audit_filters", "Agent audit search requires exact saved agent, bot and environment identities.");
  }
  return { recordId: value.recordId, botId: value.botId.toLowerCase(), environmentId: value.environmentId.toLowerCase(),
    ...(typeof value.applicationId === "string" ? { applicationId: value.applicationId.toLowerCase() } : {}) };
}

export function matchesPurviewAgent(record: PurviewAuditRecord, filters: PurviewAuditFilters): boolean | undefined {
  const agent = filters.agent;
  if (!agent) return true;
  if (filters.presetId === "copilot_studio_admin") {
    if (!record.botId) return undefined;
    return record.botId.toLowerCase() === agent.botId
      && (!record.environmentId || record.environmentId.toLowerCase() === agent.environmentId);
  }
  if (!record.appIdentity) return undefined;
  return Boolean(agent.applicationId && record.appIdentity.toLowerCase() === `copilot.studio.${agent.applicationId}`);
}

export function scopePurviewAuditResult(result: PurviewAuditResult, filters: PurviewAuditFilters): PurviewAuditResult {
  if (!filters.agent) return result;
  let unresolved = false;
  const records = result.records.filter(record => {
    const matches = matchesPurviewAgent(record, filters);
    if (matches === undefined) unresolved = true;
    return matches === true;
  });
  return { ...result, records, storedRowCount: records.length, complete: result.complete && !unresolved,
    partialReason: result.partialReason ?? (unresolved ? "audit_identity_unresolved" : null) };
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
    ...(filters.agent ? { keywordFilter: filters.presetId === "copilot_studio_admin" ? filters.agent.botId : filters.agent.applicationId! } : {}),
  };
}

export function providerQueryMatches(query: PurviewProviderQuery, displayName: string, filters: PurviewAuditFilters) {
  const expected = createProviderQueryBody(displayName, filters);
  return query.displayName === expected.displayName
    && query.filterStartDateTime === expected.filterStartDateTime
    && query.filterEndDateTime === expected.filterEndDateTime
    && query.serviceFilter === expected.serviceFilter
    && (query.keywordFilter ?? "") === (expected.keywordFilter ?? "")
    && unorderedArraysEqual(query.recordTypeFilters, expected.recordTypeFilters)
    && unorderedArraysEqual(query.operationFilters, expected.operationFilters)
    && unorderedArraysEqual(query.userPrincipalNameFilters, expected.userPrincipalNameFilters)
    && unorderedArraysEqual(query.ipAddressFilters, expected.ipAddressFilters)
    && unorderedArraysEqual(query.objectIdFilters, expected.objectIdFilters)
    && unorderedArraysEqual(query.administrativeUnitIdFilters, expected.administrativeUnitIdFilters);
}

function parseDirectQuery(value: unknown, operation: "create" | "get" | "list"): PurviewProviderQuery {
  if (!isObject(value) || "value" in value) throw new AppError(502, "provider_schema", `Microsoft Graph returned an unsupported ${operation} Audit Search query shape.`);
  if ("@odata.type" in value && value["@odata.type"] !== "#microsoft.graph.security.auditLogQuery") throw new AppError(502, "provider_schema", "Microsoft Graph returned an unsupported Audit Search query type.");
  if (Object.keys(value).some(key => !queryKeys.has(key))) throw new AppError(502, "provider_schema", "Microsoft Graph returned unknown Audit Search query fields.");
  const status = boundedString(value.status, "status", 64) as PurviewProviderQueryStatus;
  if (!queryStatuses.has(status)) throw new AppError(502, "provider_schema", "Microsoft Graph returned an invalid Audit Search query status.");
  if (!validProviderQueryId(value.id)) throw new AppError(502, "provider_schema", "Microsoft Graph returned an invalid Audit Search query ID.");
  return {
    id: value.id,
    displayName: boundedString(value.displayName, "displayName", 256),
    filterStartDateTime: providerUtcInstant(value.filterStartDateTime, "filterStartDateTime"),
    filterEndDateTime: providerUtcInstant(value.filterEndDateTime, "filterEndDateTime"),
    serviceFilter: service,
    recordTypeFilters: responseStringList(value.recordTypeFilters, "recordTypeFilters"),
    operationFilters: responseStringList(value.operationFilters, "operationFilters", 100),
    userPrincipalNameFilters: responseStringList(value.userPrincipalNameFilters, "userPrincipalNameFilters"),
    ipAddressFilters: responseStringList(value.ipAddressFilters, "ipAddressFilters"),
    objectIdFilters: responseStringList(value.objectIdFilters, "objectIdFilters"),
    administrativeUnitIdFilters: responseStringList(value.administrativeUnitIdFilters, "administrativeUnitIdFilters"),
    status,
    ...(keywordFilter !== null ? { keywordFilter } : {}),
    ...(typeof value.isRecordCountLimitExceeded === "boolean" ? { isRecordCountLimitExceeded: value.isRecordCountLimitExceeded } : {}),
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
  const tenantId = expectedTenantId.toLowerCase();
  if (wrapperTenant.toLowerCase() !== tenantId || auditTenant && auditTenant.toLowerCase() !== tenantId) throw new AppError(403, "scope_mismatch", "Microsoft Graph returned an audit record for another tenant.");
  const unknownAuditData = Object.keys(auditData).filter(key => !auditDataKeys.has(key)).length;
  const unknownDynamicProperties = Object.keys(dynamicProperties).filter(key => !dynamicPropertyKeys.has(key)).length;
  const copilotEventData = optionalObject(dynamicProperties.CopilotEventData, "auditData.dynamicProperties.CopilotEventData");
  const unknownCopilotEventData = copilotEventData === null ? 0 : Object.keys(copilotEventData).filter(key => !copilotEventDataKeys.has(key)).length;
  const messagesValue = copilotEventData?.Messages;
  const messages = parseMessages(messagesValue);
  const nativeEventId = optionalString(dynamicProperties.ID, 128)?.toLowerCase() ?? null;
  if (nativeEventId !== null && !uuid(nativeEventId)) throw new AppError(502, "provider_schema", "Microsoft Graph returned a malformed native audit event ID.");
  return {
    projectionVersion: 1,
    wrapperId: boundedString(value.id, "id", 512),
    nativeEventId,
    eventDateTime: providerUtcInstant(value.createdDateTime, "createdDateTime"),
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
  if (nextLink !== undefined && (typeof nextLink !== "string" || !nextLink || nextLink.length > 4096)) throw new AppError(502, "provider_schema", "Microsoft Graph returned an invalid Audit Search next link.");
  return { value: value.value, nextLink: nextLink ?? null as string | null };
}

async function responseJson(response: Response, signal: AbortSignal, cancellationSignal?: AbortSignal, assertCurrent?: () => void) {
  try {
    return await awaitCurrent(() => boundedProviderJson<unknown>(response, signal, maximumResponseBytes, parseAuditJson), signal, assertCurrent);
  } catch (error) {
    cancelResponse(response);
    assertCurrent?.();
    throw responseConsumptionError(error, cancellationSignal, response);
  }
}

function responseConsumptionError(error: unknown, cancellationSignal?: AbortSignal, response?: Response) {
  if (cancellationSignal?.aborted) return cancellationSignal.reason;
  const failure = error instanceof AppError ? error
    : new AppError(502, "provider_error", "Microsoft Graph Audit Search response consumption failed within its attempt deadline.");
  if (response && ["provider_error", "provider_schema", "provider_result_limit"].includes(failure.code)) {
    failure.details = responseDetails(response, Date.now());
  }
  return failure;
}

function parseAuditJson(text: string, kind: "query" | "record" = "query"): unknown {
  return parseProviderContractJson(text, {
    root: {
      fields: ["@odata.context", "@odata.count", "@odata.nextLink", "value", ...(kind === "query" ? queryKeys : [])],
      arrays: { value: kind },
    },
    query: { fields: [...queryKeys] },
    record: { fields: [...recordKeys], objects: { auditData: "auditData" } },
    auditData: { fields: [...auditDataKeys], objects: { dynamicProperties: "dynamicProperties" } },
    dynamicProperties: { fields: [...dynamicPropertyKeys], objects: { CopilotEventData: "copilotEventData" } },
    copilotEventData: { fields: [...copilotEventDataKeys], arrays: { Messages: "message" } },
    message: { fields: ["ID", "isPrompt"] },
  }, 8);
}

function parseJson(text: string) {
  try { return parseAuditJson(text, "record"); }
  catch { throw new AppError(502, "provider_schema", "Microsoft Graph returned invalid JSON."); }
}

function finishResult(records: PurviewAuditRecord[], pageCount: number, providerRowCount: number, byteCount: number, unknownFieldCount: number, complete: boolean, nextLink: string | null, partialReason: PurviewAuditPartialReason | null): PurviewAuditResult {
  return { records, pageCount, providerRowCount, storedRowCount: records.length, byteCount, unknownFieldCount, complete, nextLink, partialReason };
}

function queryUrl(id: string) {
  if (!validProviderQueryId(id)) throw new AppError(400, "invalid_provider_query_id", "Audit Search provider query ID is invalid.");
  return `${graphOrigin}${queryPath}/${encodeURIComponent(id)}`;
}

function validProviderQueryId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= 512 && id !== "." && id !== ".."
    && !/[/?#\\\u0000-\u001f\u007f-\u009f]/.test(id);
}

function validateGraphUrl(value: string, expectedPath: string, allowDescendants = true) {
  const url = URL.parse(value);
  const validPath = url && (url.pathname === expectedPath || allowDescendants && url.pathname.startsWith(`${expectedPath}/`));
  if (!url || /[\s\u0000-\u001f\u007f-\u009f]/.test(value) || url.origin !== graphOrigin || url.username || url.password || url.hash || !validPath) throw new AppError(502, "invalid_provider_link", "Audit Search provider link is outside the selected Graph v1.0 contract.");
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length || keys.some(key => !["$skiptoken", "$skip", "$top"].includes(key))
    || keys.length && keys.filter(key => key === "$skiptoken" || key === "$skip").length !== 1
    || url.searchParams.has("$skiptoken") && (!url.searchParams.get("$skiptoken") || /[\u0000-\u001f\u007f-\u009f]/.test(url.searchParams.get("$skiptoken")!))
    || url.searchParams.has("$skip") && !/^\d{1,10}$/.test(url.searchParams.get("$skip")!)
    || url.searchParams.has("$top") && (!/^\d{1,4}$/.test(url.searchParams.get("$top")!) || Number(url.searchParams.get("$top")) < 1 || Number(url.searchParams.get("$top")) > purviewMaximumRecords)) {
    throw new AppError(502, "invalid_provider_link", "Audit Search continuation changed the selected query contract.");
  }
}

function validateNextLink(value: string | null, expectedPath: string, seen: Set<string>) {
  if (value === null) return;
  validateGraphUrl(value, expectedPath, false);
  if (seen.has(pageIdentity(value))) throw new AppError(502, "provider_schema", "Microsoft Graph repeated an Audit Search page link.");
  if (new URL(value).searchParams.size === 0) throw new AppError(502, "invalid_provider_link", "Audit Search continuation is missing its paging selector.");
}

function pageIdentity(value: string) {
  const url = new URL(value);
  for (const key of ["$skip", "$top"]) {
    if (url.searchParams.has(key)) url.searchParams.set(key, String(Number(url.searchParams.get(key))));
  }
  url.searchParams.sort();
  return url.href;
}

async function awaitCurrent<T>(operation: () => T | PromiseLike<T>, signal: AbortSignal, assertCurrent?: () => void): Promise<T> {
  signal.throwIfAborted();
  assertCurrent?.();
  let onAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const result = await Promise.race([operation(), aborted]);
    signal.throwIfAborted();
    assertCurrent?.();
    return result;
  } catch (error) {
    signal.throwIfAborted();
    assertCurrent?.();
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function requestCallback(callback: () => Promise<void> | undefined, signal: AbortSignal, assertCurrent?: () => void) {
  try {
    await awaitCurrent(callback, signal, assertCurrent);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(500, "internal_error", "Audit Search request bookkeeping failed.");
  }
}

function retryAfterMilliseconds(value: string | null, responseDate: string | null, now: number) {
  if (value === null) return undefined;
  value = value.trim();
  if (/^\d+$/.test(value)) return Math.min(Number(value) * 1000, Number.MAX_SAFE_INTEGER);
  const retryAt = httpDate(value);
  if (retryAt === undefined) return undefined;
  return Math.max(0, retryAt - (httpDate(responseDate) ?? now));
}

function httpDate(value: string | null) {
  if (value === null || !/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) && new Date(date).toUTCString() === value ? date : undefined;
}

function retryDelay(retryAfter: string | null, responseDate: string | null, attempt: number, random: number, now = Date.now()) {
  return retryAfterMilliseconds(retryAfter, responseDate, now)
    ?? Math.min(250 * 2 ** (attempt - 1) + Math.floor(random * 250), 5_000);
}

function cancelResponse(response: Response) {
  // Cleanup may never settle; it must not hold up status handling or bounded retries.
  try { void response.body?.cancel().catch(() => undefined); }
  catch { /* Preserve the request outcome when response disposal fails. */ }
}

function responseRequestId(response: Response) {
  const value = response.headers.get("request-id");
  return value && /^[A-Za-z0-9-]{1,128}$/.test(value) ? value : null;
}

function safePartialPageReason(error: unknown): PurviewAuditPartialReason | null {
  if (error instanceof AppError && ["provider_throttled", "provider_error", "provider_result_limit", "audit_provider_request_limit", "audit_job_expired"].includes(error.code)) {
    return error.code as PurviewAuditPartialReason;
  }
  if (error instanceof DOMException && error.name === "TimeoutError") return "audit_activation_timeout";
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

function providerFailure(response: Response, now = Date.now()) {
  const details = responseDetails(response, now);
  const status = response.status >= 400 ? response.status : 502;
  const code = response.status === 401 ? "authorization_expired" : response.status === 403 ? "provider_denied"
    : response.status === 404 ? "provider_not_found" : response.status === 429 ? "provider_throttled" : "provider_error";
  const message = response.status === 401 ? "Microsoft Graph Audit Search authorization expired."
    : response.status === 403 ? "Microsoft Graph denied Audit Search without identifying a permission, Purview role, license, or tenant-support cause."
      : response.status === 404 ? "Microsoft Graph could not find the selected Audit Search query."
        : response.status === 429 ? "Microsoft Graph throttled Audit Search within its bounded retry budget."
          : `Microsoft Graph Audit Search returned status ${response.status}.`;
  const error = new AppError(status, code, message, details);
  if (details.retryAfterMs !== undefined && details.retryAfterMs > 0) error.retryAfterSeconds = Math.ceil(details.retryAfterMs / 1000);
  return error;
}

function responseDetails(response: Response, now: number) {
  const correlationId = responseRequestId(response);
  const retryAfterMs = retryAfterMilliseconds(response.headers.get("retry-after"), response.headers.get("date"), now);
  return { httpStatus: response.status, ...(correlationId ? { correlationId } : {}),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
}

function utcInstant(value: unknown, field: string) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new AppError(400, "invalid_audit_range", `Audit Search ${field} must be an exact UTC timestamp.`);
  const instant = new Date(value).toISOString();
  const normalizedInput = value.includes(".") ? value : value.replace("Z", ".000Z");
  if (instant !== normalizedInput) throw new AppError(400, "invalid_audit_range", `Audit Search ${field} must be an exact UTC timestamp.`);
  return instant;
}

function providerUtcInstant(value: unknown, field: string) {
  try { return utcInstant(value, field); }
  catch { throw new AppError(502, "provider_schema", `Microsoft Graph returned an invalid ${field}.`); }
}

function stringList(value: unknown, field: string, validate: (item: string) => boolean, maximumLength = 256, maximumItems = 20) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximumItems || value.some(item => typeof item !== "string" || !item || item.length > maximumLength || /[\u0000-\u001f\u007f-\u009f]/.test(item) || !validate(item))) throw new AppError(400, "invalid_audit_filters", `Audit Search ${field} is invalid.`);
  if (new Set(value).size !== value.length) throw new AppError(400, "invalid_audit_filters", `Audit Search ${field} contains duplicates.`);
  return [...value].sort(ordinal);
}

function responseStringList(value: unknown, field: string, maximum = 20) {
  if (!Array.isArray(value) || value.length > maximum || value.some(item => typeof item !== "string" || !item || item.length > 512 || /[\u0000-\u001f\u007f-\u009f]/.test(item))
    || new Set(value).size !== value.length) throw new AppError(502, "provider_schema", `Microsoft Graph returned an invalid ${field}.`);
  return [...value] as string[];
}

function boundedString(value: unknown, field: string, maximum: number) {
  if (typeof value !== "string" || !value || value.length > maximum || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new AppError(502, "provider_schema", `Microsoft Graph returned an invalid ${field}.`);
  return value;
}

function optionalString(value: unknown, maximum: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > maximum || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new AppError(502, "provider_schema", "Microsoft Graph returned malformed typed audit metadata.");
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