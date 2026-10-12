import { setTimeout as delay } from "node:timers/promises";
import { AppError, errorTelemetry, isTimeoutError } from "../errors.js";
import {
  derivePowerPlatformAuthoringTool,
  agentComponentCountFields,
  isAgentComponentCounts,
  isMakerSharing,
  isNullableInventoryCount,
  powerPlatformResourceTypes,
  type InventoryConnector,
  type InventoryConnectorOperation,
  type InventoryFieldMaturity,
  type InventoryFieldProvenance,
  type InventoryIdentifier,
  type PowerPlatformResource,
  type PowerPlatformResourceDetails,
  type PowerPlatformResourceType,
} from "../types/powerPlatformInventory.js";
import { normalizeEnvironmentIdentity, normalizeNativeIdentity, powerPlatformAgentKey, sortIdentifiers } from "./inventoryIdentity.js";
import { boundedProviderJson, parseProviderContractJson } from "./providerJson.js";
import { operationalLog } from "./telemetry.js";
import { inventoryLimits, type InventoryPage } from "../types/inventoryRecords.js";

const resourceQueryEndpoint = "https://api.powerplatform.com/resourcequery/resources/query?api-version=2024-10-01";
const defaultPageSize = 100;
const maximumConnectors = 200;
const maximumOperations = 200;

export { powerPlatformResourceTypes } from "../types/powerPlatformInventory.js";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

type RetryPolicy = {
  maxAttempts: number;
  baseDelayMs: number;
  maximumDelayMs: number;
  delay: (delayMs: number, signal?: AbortSignal) => Promise<unknown>;
};

export type ResourceQueryOptions = {
  signal?: AbortSignal;
  /** Absolute caller execution deadline in Unix milliseconds. */
  executionDeadlineAt?: number;
  assertCurrent?: () => void;
  beforeRequest?: () => Promise<void>;
  getAccessToken?: () => Promise<string>;
  cloud?: "global" | "usgov" | "china";
  expectedTenantId?: string;
  environmentId?: string;
  onProgress?: (progress: { pages: number; observedCount: number; totalRecords: number }) => Promise<void> | void;
};

type ResourceQueryPage = {
  totalRecords?: unknown;
  count?: unknown;
  resultTruncated?: unknown;
  skipToken?: unknown;
  data?: unknown;
};

type QueryLogContext = { provider: "power_platform"; source: "inventory_refresh" | "capability_check" | "agent_sharing_diagnostic"; page: number };
type SchemaDiagnostics = {
  reason: string;
  field?: string;
  resourceType?: PowerPlatformResourceType;
  actualType?: string;
  length?: number;
  maximumLength?: number;
  resourceIndex?: number;
  firstSeenPage?: number;
};

class InventorySchemaError extends AppError {
  constructor(message: string, readonly diagnostics: SchemaDiagnostics) {
    super(502, "provider_schema", message);
  }
}

const defaultRetryPolicy: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maximumDelayMs: 10_000,
  delay: (milliseconds, signal) => delay(milliseconds, undefined, { signal }),
};

export class PowerPlatformResourceQueryClient {
  private readonly retryPolicy: RetryPolicy;

  constructor(
    private readonly fetcher: FetchLike = fetch,
    retryPolicy: Partial<RetryPolicy> = {},
  ) {
    this.retryPolicy = { ...defaultRetryPolicy, ...retryPolicy };
  }

  async *pages(accessToken: string, types: readonly PowerPlatformResourceType[], options: ResourceQueryOptions & {
    visit: (token: string) => Promise<void>;
  }): AsyncGenerator<InventoryPage<PowerPlatformResource>> {
    if (options.cloud && options.cloud !== "global") throw new AppError(501, "unsupported_cloud", "Power Platform inventory is implemented only for the documented global-cloud endpoint.");
    const requestedTypes = validateTypes(types);
    const environmentId = validateEnvironmentId(options.environmentId);
    const expectedTenantId = validateExpectedTenantId(options.expectedTenantId);
    if (options.executionDeadlineAt !== undefined && !Number.isSafeInteger(options.executionDeadlineAt)) {
      throw new AppError(500, "invalid_read_policy", "Inventory execution requires a finite absolute deadline.");
    }
    const durationMs = Math.max(0, Math.min(inventoryLimits.powerPlatformDeadlineMs,
      options.executionDeadlineAt === undefined ? Infinity : options.executionDeadlineAt - Date.now()));
    const deadlineAt = performance.now() + durationMs;
    const deadlineSignal = AbortSignal.timeout(durationMs);
    const signal = options.signal ? AbortSignal.any([options.signal, deadlineSignal]) : deadlineSignal;
    const assertCurrent = () => {
      signal.throwIfAborted();
      options.assertCurrent?.();
      if (performance.now() >= deadlineAt || options.executionDeadlineAt !== undefined && Date.now() >= options.executionDeadlineAt) {
        throw new DOMException("Inventory enumeration deadline expired.", "TimeoutError");
      }
    };
    let observedCount = 0;
    let skipToken: string | undefined;
    let totalRecords: number | undefined;
    let pages = 0;
    let unknownFieldCount = 0;
    const logContext: QueryLogContext = { provider: "power_platform", source: "inventory_refresh", page: 0 };
    const startedAt = performance.now();
    let completedPages = 0;
    let completedCount = 0;
    let stage = "request";
    let terminal = false;
    let metadata: ReturnType<typeof pageTelemetry> = {};
    operationalLog("info", "inventory_query_started", {
      ...logContext, requestedTypeCount: requestedTypes.length, environmentScoped: Boolean(environmentId),
      pageSize: defaultPageSize, pageLimit: inventoryLimits.pages, rowLimit: inventoryLimits.sourceRows, deadlineMs: durationMs,
    });

    try {
      do {
        logContext.page = pages + 1;
        metadata = {};
        stage = "request";
        assertCurrent();
        if (pages >= inventoryLimits.pages) throw new AppError(502, "provider_page_limit", "Inventory exceeds 10000 pages.");
        // The initial page must not collide with an opaque provider continuation.
        const pageToken = JSON.stringify(skipToken ?? null);
        await this.withSignal(() => options.visit(pageToken), signal);
        assertCurrent();
        const page = await this.requestPage(accessToken,
          requestedTypes, skipToken, signal, environmentId, defaultPageSize, logContext, 600_000, assertCurrent, options.getAccessToken, options.beforeRequest);
        assertCurrent();
        metadata = pageTelemetry(page);
        stage = "validation";
        const parsed = parsePage(page, requestedTypes, environmentId, expectedTenantId, observedCount);
        if (parsed.totalRecords > inventoryLimits.sourceRows) throw new AppError(502, "provider_result_limit", "Inventory exceeds 100000 resources.");
        pages += 1;
        totalRecords ??= parsed.totalRecords;
        if (parsed.totalRecords !== totalRecords) throw new InventorySchemaError("Power Platform inventory changed totalRecords during paging.", { reason: "changed_total", field: "totalRecords" });
        if (parsed.skipToken === undefined && observedCount + parsed.resources.length !== totalRecords) {
          throw new InventorySchemaError("Power Platform inventory ended before the documented total was enumerated.", { reason: "incomplete_enumeration" });
        }
        observedCount += parsed.resources.length;
        const omittedFieldCount = parsed.unknownFieldCount + parsed.resources.reduce((count, resource) => count + resource.unknownFieldCount, 0);
        unknownFieldCount += omittedFieldCount;
        if (omittedFieldCount) operationalLog("warn", "provider_schema_omission", { ...logContext, count: omittedFieldCount });
        operationalLog("info", "inventory_page_validated", {
          ...logContext, ...metadata, omittedFieldCount,
        });
        stage = "save_page";
        yield { token: pageToken, nextToken: parsed.skipToken === undefined ? null : JSON.stringify(parsed.skipToken), records: parsed.resources,
          rawCount: parsed.resources.length, expectedCount: totalRecords, page: pages, omittedFieldCount };
        assertCurrent();
        skipToken = parsed.skipToken;
        stage = "record_progress";
        const progress = { pages, observedCount, totalRecords };
        if (options.onProgress) await this.withSignal(async () => options.onProgress!(progress), signal);
        assertCurrent();
        completedPages = pages;
        completedCount = observedCount;
      } while (skipToken);

      stage = "completion";
      operationalLog("info", "inventory_query_completed", {
        ...logContext, pages, observedCount, totalRecords,
        omittedFieldCount: unknownFieldCount, durationMs: Math.round(performance.now() - startedAt),
      });
      terminal = true;
    } catch (error) {
      let cause = error;
      try { assertCurrent(); } catch (currentError) { cause = currentError; }
      const failure = isTimeoutError(cause) ? new AppError(504, "provider_timeout", (deadlineSignal.aborted && cause === deadlineSignal.reason || performance.now() >= deadlineAt)
        ? `Power Platform inventory exceeded the ${durationMs / 1_000}-second enumeration limit. No incomplete source was saved. Retry the refresh or select a narrower scope.`
        : "Power Platform inventory page request timed out before complete enumeration. No incomplete snapshot was saved. Retry the refresh.") : cause;
      operationalLog("error", "inventory_query_failed", {
        ...logContext, ...metadata, stage, pages: completedPages, observedCount: completedCount,
        durationMs: Math.round(performance.now() - startedAt), ...errorTelemetry(failure, "provider_error"),
        ...(cause instanceof InventorySchemaError ? cause.diagnostics : {}),
      });
      terminal = true;
      throw failure;
    } finally {
      // for-await closes a rejected durable consumer with return(), not throw().
      if (!terminal) operationalLog("warn", "inventory_query_interrupted", {
        ...logContext, stage, pages: completedPages, observedCount: completedCount,
        outcome: "incomplete", durationMs: Math.round(performance.now() - startedAt),
      });
    }
  }

  async checkAccess(accessToken: string, signal?: AbortSignal) {
    const requestedTypes = ["microsoft.powerplatform/environments"] as const;
    const logContext: QueryLogContext = { provider: "power_platform", source: "capability_check", page: 1 };
    const deadlineSignal = AbortSignal.timeout(10_000);
    const checkSignal = signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal;
    let metadata: ReturnType<typeof pageTelemetry> = {};
    try {
      const page = await this.requestPage(accessToken, requestedTypes, undefined, checkSignal, undefined, 1, logContext);
      checkSignal.throwIfAborted();
      metadata = pageTelemetry(page);
      const parsed = parsePage(page, requestedTypes);
      if (parsed.resources.length > 1) throw new InventorySchemaError("Power Platform access check returned an oversized page.", { reason: "oversized_access_check", field: "count" });
      operationalLog("info", "inventory_access_check_completed", { ...logContext, ...metadata });
    } catch (error) {
      const failure = checkSignal.aborted ? checkSignal.reason : error;
      operationalLog("warn", "inventory_query_failed", {
        ...logContext, ...metadata, ...errorTelemetry(failure, "provider_error"),
        ...(failure instanceof InventorySchemaError ? failure.diagnostics : {}),
      });
      throw failure;
    }
  }

  async getDiagnosticAgentDetail(accessToken: string, nativeId: string, options: ResourceQueryOptions & {
    expectedTenantId: string; environmentId: string;
  }): Promise<unknown> {
    if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(nativeId)) {
      throw new AppError(400, "invalid_diagnostic_identity", "Agent diagnostics require an exact native GUID.");
    }
    if (options.cloud && options.cloud !== "global") throw new AppError(501, "unsupported_cloud", "Agent diagnostics support only the global-cloud endpoint.");
    const tenantId = validateExpectedTenantId(options.expectedTenantId);
    const environmentId = validateEnvironmentId(options.environmentId);
    if (!tenantId || !environmentId) throw new AppError(400, "invalid_diagnostic_scope", "Agent diagnostics require a tenant and environment.");
    const signal = options.signal ?? AbortSignal.timeout(60_000);
    signal.throwIfAborted();
    options.assertCurrent?.();
    const types = ["microsoft.copilotstudio/agents"] as const;
    const page = await this.requestPage(accessToken, types, undefined, signal, environmentId, 1,
      { provider: "power_platform", source: "agent_sharing_diagnostic", page: 1 },
      this.retryPolicy.maximumDelayMs, options.assertCurrent, options.getAccessToken, options.beforeRequest, { nativeId, tenantId });
    signal.throwIfAborted();
    options.assertCurrent?.();
    const parsed = parsePage(page, types, environmentId, tenantId, 0);
    if (parsed.totalRecords === 0) throw new AppError(404, "diagnostic_target_missing", "The targeted agent was not returned.");
    if (parsed.totalRecords !== 1 || parsed.resources.length !== 1 || parsed.skipToken
      || normalizeNativeIdentity(parsed.resources[0].nativeId) !== normalizeNativeIdentity(nativeId)) {
      throw new AppError(502, "diagnostic_scope_mismatch", "Agent diagnostic response did not contain only the requested agent.");
    }
    return page;
  }

  private async requestPage(accessToken: string, types: readonly PowerPlatformResourceType[], skipToken: string | undefined, signal: AbortSignal, environmentId: string | undefined, pageSize: number, logContext: QueryLogContext, retryAfterLimit = this.retryPolicy.maximumDelayMs, assertCurrent?: () => void, getAccessToken?: () => Promise<string>, beforeRequest?: () => Promise<void>, exactIdentity?: { nativeId: string; tenantId: string }): Promise<ResourceQueryPage> {
    const body = {
      TableName: "PowerPlatformResources",
      Clauses: [{
        $type: "where",
        FieldName: "type",
        Operator: "in~",
        Values: types.map(type => `'${type.replaceAll("'", "''")}'`),
      }, ...(environmentId ? [{ $type: "where", FieldName: "properties.environmentId", Operator: "==", Values: [JSON.stringify(environmentId)] }] : []),
      ...(exactIdentity ? [
        { $type: "where", FieldName: "tenantId", Operator: "==", Values: [JSON.stringify(exactIdentity.tenantId)] },
        { $type: "where", FieldName: "name", Operator: "==", Values: [JSON.stringify(exactIdentity.nativeId)] },
      ] : []), {
        $type: "orderby",
        FieldNamesAscDesc: { tenantId: "asc", type: "asc", "tostring(properties.environmentId)": "asc", name: "asc" },
      }],
      Options: {
        Top: pageSize,
        // Explicit Skip overrides the continuation offset, including when it is zero.
        ...(skipToken ? { SkipToken: skipToken } : { Skip: 0 }),
      },
    };

    for (let attempt = 1; attempt <= this.retryPolicy.maxAttempts; attempt += 1) {
      signal.throwIfAborted();
      assertCurrent?.();
      const token = getAccessToken ? await this.withSignal(getAccessToken, signal) : accessToken;
      signal.throwIfAborted();
      assertCurrent?.();
      if (beforeRequest) await this.withSignal(beforeRequest, signal);
      signal.throwIfAborted();
      assertCurrent?.();
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
      const startedAt = performance.now();
      const assertRequestCurrent = () => {
        signal.throwIfAborted();
        assertCurrent?.();
        requestSignal.throwIfAborted();
        if (performance.now() - startedAt >= 10_000) throw new DOMException("Inventory page deadline expired.", "TimeoutError");
      };
      const retry = async (retryDelayMs: number, reason: string) => {
        operationalLog("warn", "inventory_provider_retry", { ...logContext, attempt, retryDelayMs, reason });
        await this.waitForRetry(retryDelayMs, signal);
      };
      operationalLog("info", "inventory_provider_request", { ...logContext, attempt, pageSize, hasContinuation: Boolean(skipToken) });
      let response: Response;
      let undeliveredResponse: Response | undefined;
      let responseDisposed = false;
      const dispose = (value: Response) => {
        if (responseDisposed) return;
        responseDisposed = true;
        disposeResponse(value);
      };
      try {
        const fetching = this.fetcher(resourceQueryEndpoint, {
          method: "POST",
          redirect: "error",
          signal: requestSignal,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
        void fetching.then(value => {
          undeliveredResponse = value;
          if (requestSignal.aborted) dispose(value);
        }, () => undefined);
        response = await this.withSignal(() => fetching, requestSignal);
        undeliveredResponse = undefined;
      } catch (error) {
        if (undeliveredResponse) dispose(undeliveredResponse);
        operationalLog("warn", "inventory_provider_failure", {
          ...logContext, attempt, stage: "transport", durationMs: Math.round(performance.now() - startedAt),
          ...errorTelemetry(signal.aborted ? signal.reason : error, "provider_error"),
        });
        if (signal.aborted) throw signal.reason;
        assertCurrent?.();
        if (attempt === this.retryPolicy.maxAttempts) throw error;
        await retry(Math.min(this.retryPolicy.baseDelayMs * attempt, this.retryPolicy.maximumDelayMs), "transport");
        continue;
      }

      try {
        assertRequestCurrent();
      } catch (error) {
        dispose(response);
        throw error;
      }
      operationalLog(response.ok ? "info" : "warn", "inventory_provider_response", {
        ...logContext, attempt, status: response.status, durationMs: Math.round(performance.now() - startedAt),
        providerRequestId: response.headers.get("x-ms-request-id") ?? response.headers.get("request-id"),
        providerCorrelationId: response.headers.get("x-ms-correlation-request-id"),
      });
      if (response.redirected || response.url && new URL(response.url).origin !== new URL(resourceQueryEndpoint).origin) {
        dispose(response);
        throw new AppError(502, "invalid_provider_link", "Power Platform inventory refused a redirected or foreign-origin response.");
      }
      if (response.ok) {
        try {
          const page = await boundedProviderJson<ResourceQueryPage>(response, requestSignal, undefined, parseResourceQueryJson);
          assertRequestCurrent();
          return page;
        } catch (error) {
          operationalLog("warn", "inventory_provider_failure", {
            ...logContext, attempt, stage: "response_body", durationMs: Math.round(performance.now() - startedAt),
            ...errorTelemetry(signal.aborted ? signal.reason : error, "provider_error"),
          });
          if (signal.aborted) throw signal.reason;
          assertCurrent?.();
          if (error instanceof AppError || attempt === this.retryPolicy.maxAttempts) throw error;
          dispose(response);
          await retry(Math.min(this.retryPolicy.baseDelayMs * attempt, this.retryPolicy.maximumDelayMs), "response_body");
          continue;
        }
      }
      dispose(response);
      signal.throwIfAborted();
      assertCurrent?.();
      const retryAfter = retryAfterMs(response.headers.get("retry-after"));
      const providerRequestId = response.headers.get("x-ms-request-id") ?? response.headers.get("request-id");
      if (attempt === this.retryPolicy.maxAttempts || (response.status !== 429 && response.status < 500)
        || retryAfter !== undefined && retryAfter > retryAfterLimit) {
        throw new AppError(response.status, "provider_error", "Power Platform inventory query failed.", {
          httpStatus: response.status,
          ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }),
          ...(providerRequestId && /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(providerRequestId)
            ? { providerRequestId } : {}),
        });
      }
      await retry(retryAfter ?? Math.min(this.retryPolicy.baseDelayMs * attempt, this.retryPolicy.maximumDelayMs),
        response.status === 429 ? "throttled" : "server_error");
    }

    throw new AppError(500, "retry_exhausted", "Power Platform inventory retry attempts were exhausted.");
  }

  private async waitForRetry(delayMs: number, signal: AbortSignal) {
    await this.withSignal(() => this.retryPolicy.delay(delayMs, signal), signal);
  }

  private async withSignal<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw signal.reason;
    let removeAbort: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbort = () => signal.removeEventListener("abort", onAbort);
    });
    try { return await Promise.race([operation(), aborted]); }
    finally { removeAbort(); }
  }
}

function validateEnvironmentId(value: string | undefined) {
  if (value === undefined || value === "") return undefined;
  if (!unicodeText(value) || value.length > 512 || /[\r\n]/.test(value)) throw new AppError(400, "invalid_inventory_scope", "Inventory environment scope is invalid.");
  return value;
}

function validateExpectedTenantId(value: string | undefined) {
  if (value === undefined) return undefined;
  if (!validText(value, 128) || /[\r\n\0]/.test(value)) throw new AppError(400, "invalid_inventory_scope", "Inventory tenant scope is invalid.");
  return value;
}

function validateTypes(types: readonly PowerPlatformResourceType[]) {
  const allowed = new Set<string>(powerPlatformResourceTypes);
  const unique = [...new Set(types)];
  if (unique.length === 0 || unique.some(type => !allowed.has(type))) throw new AppError(400, "invalid_inventory_scope", "Inventory resource types must use the supported allowlist.");
  return unique;
}

function pageTelemetry(page: unknown): {
  totalRecords?: number; returnedCount?: number; dataCount?: number; hasContinuation?: boolean; resultTruncated?: boolean;
} {
  if (!isRecord(page)) return {};
  return {
    totalRecords: typeof page.totalRecords === "number" && Number.isSafeInteger(page.totalRecords) ? page.totalRecords : undefined,
    returnedCount: typeof page.count === "number" && Number.isSafeInteger(page.count) ? page.count : undefined,
    dataCount: Array.isArray(page.data) ? page.data.length : undefined,
    hasContinuation: typeof page.skipToken === "string" && page.skipToken.length > 0,
    resultTruncated: [0, 1, false, true].includes(page.resultTruncated as never) ? Boolean(page.resultTruncated) : undefined,
  };
}

function valueType(value: unknown) {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

function parsePage(page: unknown, requestedTypes: readonly PowerPlatformResourceType[], expectedEnvironmentId?: string, expectedTenantId?: string, previouslyObservedCount = 0) {
  if (!isRecord(page)) {
    throw new InventorySchemaError("Power Platform inventory returned an invalid page shape.", { reason: "invalid_page", actualType: valueType(page) });
  }
  if (!Number.isSafeInteger(page.totalRecords) || (page.totalRecords as number) < 0) {
    throw new InventorySchemaError("Power Platform inventory returned an invalid page shape.", { reason: "invalid_total", field: "totalRecords", actualType: valueType(page.totalRecords) });
  }
  if (!Number.isSafeInteger(page.count) || (page.count as number) < 0 || (page.count as number) > defaultPageSize) {
    throw new InventorySchemaError("Power Platform inventory returned an invalid page shape.", { reason: "invalid_count", field: "count", actualType: valueType(page.count) });
  }
  if (!Array.isArray(page.data) || page.data.length !== page.count) {
    throw new InventorySchemaError("Power Platform inventory returned an invalid page shape.", { reason: "invalid_page_data", field: "data", actualType: valueType(page.data) });
  }
  const skipToken = page.skipToken === undefined || page.skipToken === null || page.skipToken === ""
    ? undefined
    : typeof page.skipToken === "string" && page.skipToken.length <= 4_096
      ? page.skipToken
      : invalidContinuationToken(page.skipToken);
  if (![0, 1, false, true].includes(page.resultTruncated as never)) {
    throw new InventorySchemaError("Power Platform inventory returned an invalid truncation marker.", { reason: "invalid_truncation", field: "resultTruncated", actualType: valueType(page.resultTruncated) });
  }
  const pageTruncated = page.resultTruncated === 1 || page.resultTruncated === true;
  const observedCount = previouslyObservedCount + page.data.length;
  if (observedCount > (page.totalRecords as number)) throw new InventorySchemaError("Power Platform inventory returned more resources than the documented total.", { reason: "exceeded_total", field: "totalRecords" });
  // The provider can retain resultTruncated on the final page; exact enumeration, not that marker alone, proves completion.
  if (pageTruncated && !skipToken && observedCount < (page.totalRecords as number)) throw new InventorySchemaError("Power Platform inventory marked a page truncated without a continuation token.", { reason: "missing_continuation", field: "skipToken" });
  if (skipToken && (!pageTruncated || page.count === 0 || observedCount === page.totalRecords)) throw new InventorySchemaError("Power Platform inventory returned inconsistent continuation metadata.", { reason: "inconsistent_continuation" });
  const resources = page.data.map((value, index) => {
    try {
      return parseResource(value, expectedTenantId);
    } catch (error) {
      if (error instanceof InventorySchemaError) error.diagnostics.resourceIndex = index + 1;
      throw error;
    }
  });
  const requested = new Set(requestedTypes);
  const identities = new Set<string>();
  for (const [index, resource] of resources.entries()) {
    const identity = `${normalizeNativeIdentity(resource.tenantId)}\0${resource.type}\0${powerPlatformAgentKey(resource.environmentId, resource.nativeId)}`;
    if (identities.has(identity)) throw new InventorySchemaError("Power Platform inventory returned a duplicate resource identity.", {
      reason: "duplicate_identity", resourceType: resource.type, resourceIndex: index + 1,
    });
    identities.add(identity);
    const environmentMismatch = expectedEnvironmentId && (resource.environmentId === null
      || normalizeEnvironmentIdentity(resource.environmentId) !== normalizeEnvironmentIdentity(expectedEnvironmentId));
    if (!requested.has(resource.type) || environmentMismatch
      || expectedTenantId && normalizeNativeIdentity(resource.tenantId) !== normalizeNativeIdentity(expectedTenantId)) {
      const field = !requested.has(resource.type) ? "type" : environmentMismatch ? "environmentId" : "tenantId";
      throw new InventorySchemaError("Power Platform inventory returned data outside the requested tenant, environment, or resource type scope.", {
        reason: "scope_mismatch", field, resourceType: resource.type, resourceIndex: index + 1,
      });
    }
  }
  return {
    totalRecords: page.totalRecords as number,
    resources,
    skipToken,
    unknownFieldCount: Object.keys(page).filter(key => !["totalRecords", "count", "resultTruncated", "skipToken", "data"].includes(key)).length,
  };
}

function parseResource(value: unknown, expectedTenantId?: string): PowerPlatformResource {
  if (!isRecord(value)) {
    throw new InventorySchemaError("Power Platform inventory returned an invalid resource identity.", { reason: "invalid_resource", actualType: valueType(value) });
  }
  if (typeof value.type !== "string" || !powerPlatformResourceTypes.includes(value.type as PowerPlatformResourceType)) {
    throw new InventorySchemaError("Power Platform inventory returned an invalid resource identity.", { reason: "invalid_resource_type", field: "type", actualType: valueType(value.type) });
  }
  const type = value.type as PowerPlatformResourceType;
  if (typeof value.name !== "string") {
    throw new InventorySchemaError("Power Platform inventory returned an invalid resource identity.", { reason: "invalid_identity_type", field: "name", actualType: valueType(value.name), resourceType: type });
  }
  const sourceTenantId = value.tenantId;
  const tenantId = typeof sourceTenantId === "string" && expectedTenantId
    && normalizeNativeIdentity(sourceTenantId) === normalizeNativeIdentity(expectedTenantId) ? expectedTenantId : sourceTenantId;
  if (typeof tenantId !== "string") throw new InventorySchemaError("Power Platform inventory returned an invalid resource identity.", {
    reason: "invalid_identity_type", field: "tenantId", actualType: valueType(tenantId), resourceType: type,
  });
  for (const [field, length, maximumLength] of [["tenantId", tenantId.length, 128], ["name", value.name.length, 512]] as const) {
    if (length === 0 || length > maximumLength) {
      throw new InventorySchemaError(`Power Platform inventory returned an ${length === 0 ? "empty" : "oversized"} ${field} for ${value.type} (length ${length}; expected 1-${maximumLength}).`, {
        reason: length === 0 ? "empty_identity" : "identity_too_long", field, length, maximumLength, resourceType: type,
      });
    }
  }
  for (const [field, text] of [["tenantId", tenantId], ["name", value.name]] as const) {
    if (!unicodeText(text)) throw new InventorySchemaError("Power Platform inventory returned invalid resource identity text.", {
      reason: "invalid_identity_text", field, resourceType: type,
    });
  }
  if (value.location !== undefined && value.location !== null && !unicodeText(value.location)) {
    throw new InventorySchemaError("Power Platform inventory returned an invalid resource location.", { reason: "invalid_location", field: "location", actualType: valueType(value.location), resourceType: type });
  }
  const context = projectionContext(value.properties, type);
  context.omittedCount += Object.keys(value).filter(key => !["id", "tenantId", "name", "type", "location", "properties"].includes(key)).length;
  let providerResourceId: string | null | undefined;
  if (Object.hasOwn(value, "id")) {
    if (value.id !== null && !validText(value.id, 2048)) invalidObservation("id", value.id);
    providerResourceId = value.id;
    context.provenance.providerResourceId = { sourceSystem: "power_platform", path: "id", maturity: "ga" };
  }
  const displayName = optionalString(context, "displayName", "properties.displayName", "ga", 512);
  const environmentId = optionalString(context, "environmentId", "properties.environmentId", "ga", 512);
  const createdAt = optionalDate(context, "createdAt", "properties.createdAt", "ga");
  const createdBy = optionalString(context, "createdBy", "properties.createdBy", "ga", 512);
  const lastPublishedAt = optionalDate(context, "lastPublishedAt", "properties.lastPublishedAt", "ga");
  const propertiesName = optionalString(context, "name", "properties.name", "ga", 512);
  const botId = optionalString(context, "botId", "properties.botId", "ga", 512);
  const identifiers: InventoryIdentifier[] = [
    { kind: "power_platform_resource_id", value: value.name },
    ...(environmentId ? [{ kind: "environment_id" as const, value: environmentId }] : []),
    ...(propertiesName ? [{ kind: "cds_bot_id" as const, value: propertiesName }] : []),
    ...(botId && botId !== propertiesName ? [{ kind: "cds_bot_id" as const, value: botId }] : []),
    ...identifier(context, "entraAppId", "entra_app_id"),
    ...identifier(context, "entraAgentId", "entra_agent_id"),
    ...identifier(context, "entraAgentBlueprintId", "entra_blueprint_id"),
  ];
  const details = projectDetails(context);
  const createdIn = details.createdIn ?? null;
  const authoringTool = derivePowerPlatformAuthoringTool(type, createdIn);
  const agentKind = deriveAgentKind(type, createdIn);
  const lifecycle = deriveLifecycle(type, context.properties.lastPublishedAt, Object.hasOwn(context.properties, "lastPublishedAt"), lastPublishedAt);
  context.provenance.sourceSystem = { sourceSystem: "power_platform", path: "PowerPlatformResources", maturity: "ga" };
  context.provenance.tenantId = { sourceSystem: "power_platform", path: "tenantId", maturity: "ga" };
  context.provenance.nativeId = { sourceSystem: "power_platform", path: "name", maturity: "ga" };
  if (typeof value.location === "string") context.provenance.location = { sourceSystem: "power_platform", path: "location", maturity: "ga" };
  context.provenance.authoringTool = { sourceSystem: "power_platform", path: authoringTool && type === "microsoft.copilotstudio/agents" ? "properties.createdIn" : authoringTool ? "type" : "not_supplied", maturity: "ga" };
  context.provenance.agentKind = { sourceSystem: "power_platform", path: type === "microsoft.copilotstudio/agents" && agentKind !== "agent" ? "properties.createdIn" : "type", maturity: "ga" };
  context.provenance.lifecycle = { sourceSystem: "power_platform", path: type === "microsoft.copilotstudio/agents" && Object.hasOwn(context.properties, "lastPublishedAt") ? "properties.lastPublishedAt" : "type", maturity: "ga" };
  context.provenance.creatorType = { sourceSystem: "power_platform", path: "not_supplied", maturity: "ga" };
  context.provenance.identityConfidence = { sourceSystem: "power_platform", path: "name", maturity: "ga" };
  return {
    tenantId,
    nativeId: value.name,
    ...(providerResourceId !== undefined ? { providerResourceId } : {}),
    type,
    location: typeof value.location === "string" ? value.location.slice(0, 256).replace(/[\uD800-\uDBFF]$/, "") : null,
    displayName,
    environmentId,
    createdAt,
    createdBy,
    lastPublishedAt,
    sourceSystem: "power_platform",
    authoringTool,
    creatorType: "unknown",
    agentKind,
    lifecycle,
    identityConfidence: identifiers.length > 1 ? "exact_native" : "partial",
    identifiers: sortIdentifiers(identifiers),
    provenance: context.provenance,
    details,
    unknownFieldCount: context.omittedCount,
  };
}

const sharedProperties = fields("ga", "displayName", "createdAt", "createdBy");
const ownedResourceProperties = fields("ga", "ownerId", "environmentId", "lastModifiedAt", "lastModifiedBy");
const connectorUsageProperties = fields("preview", "powerPlatformConnectors");
const resourcePropertySchemas: Record<PowerPlatformResourceType, ReadonlyMap<string, InventoryFieldMaturity>> = {
  "microsoft.copilotstudio/agents": schema(sharedProperties, ownedResourceProperties, fields("ga", "lastPublishedAt", "createdIn", "schemaName", "name", "botId", "entraAppId", "entraAgentId", "entraAgentBlueprintId"), fields("preview", "isQuarantined", "quarantinedAt", "isManaged", "orchestration", "model", "authentication", "channels", "capabilitiesCounts", "isWebSearchEnabledForKnowledge", "sharedWithViewers", "sharedWithEditors"), fields("observed", "harness", "titleId", "instructionsCharactersCount", "componentsCounts", "flows", "triggers"), connectorUsageProperties),
  "microsoft.powerplatform/environments": schema(sharedProperties, fields("ga", "environmentType", "isManaged", "environmentGroup", "environmentGroupId", "lastModifiedAt")),
};

function parseResourceQueryJson(text: string): unknown {
  return parseProviderContractJson(text, {
    root: { fields: ["totalRecords", "count", "resultTruncated", "skipToken", "data"], arrays: { data: "resource" } },
    resource: {
      fields: ["id", "tenantId", "name", "type", "location", "properties"],
      objects: { properties: value => !isRecord(value) ? undefined
        : value.type === "microsoft.copilotstudio/agents" ? "agentProperties"
          : value.type === "microsoft.powerplatform/environments" ? "environmentProperties" : undefined },
    },
    agentProperties: {
      fields: [...resourcePropertySchemas["microsoft.copilotstudio/agents"].keys()],
      objects: { capabilitiesCounts: "counts", sharedWithViewers: "viewers", sharedWithEditors: "editors",
        componentsCounts: "components" }, arrays: { powerPlatformConnectors: "connector" },
    },
    environmentProperties: { fields: [...resourcePropertySchemas["microsoft.powerplatform/environments"].keys()] },
    counts: { fields: ["distinctPowerPlatformConnectors", "distinctPowerPlatformConnectorsOperations", "distinctFlows"] },
    viewers: { fields: ["entireTenant", "userCount", "groupCount"] },
    editors: { fields: ["userCount", "groupCount"] },
    components: { fields: [...agentComponentCountFields, "knowledgeByType"], objects: { knowledgeByType: "knowledgeTypes" } },
    knowledgeTypes: { fields: "*" },
    connector: { fields: ["connectorId", "operations"], arrays: { operations: "operation" } },
    operation: { fields: ["operationId", "createdBy", "usedAs", "isEnabled", "requiresEndUserConsent", "whenCanBeUsed", "connectionProvider"] },
  }, 8);
}

type ProjectionContext = {
  properties: Record<string, unknown>;
  schema: ReadonlyMap<string, InventoryFieldMaturity>;
  provenance: Record<string, InventoryFieldProvenance>;
  omittedCount: number;
  capabilityDetailsTruncated: boolean;
  retainedOperations: number;
};

function projectionContext(value: unknown, type: PowerPlatformResourceType): ProjectionContext {
  const propertySchema = resourcePropertySchemas[type];
  if (value === undefined || value === null) return { properties: {}, schema: propertySchema, provenance: {}, omittedCount: 0, capabilityDetailsTruncated: false, retainedOperations: 0 };
  if (!isRecord(value)) return { properties: {}, schema: propertySchema, provenance: {}, omittedCount: 1, capabilityDetailsTruncated: false, retainedOperations: 0 };
  return {
    properties: value,
    schema: propertySchema,
    provenance: {},
    omittedCount: Object.keys(value).filter(key => !propertySchema.has(key)).length,
    capabilityDetailsTruncated: false,
    retainedOperations: 0,
  };
}

function projectDetails(context: ProjectionContext): PowerPlatformResourceDetails {
  const details: PowerPlatformResourceDetails = {};
  assign(details, "ownerId", optionalString(context, "ownerId", "properties.ownerId", "ga", 512));
  assign(details, "lastModifiedAt", optionalDate(context, "lastModifiedAt", "properties.lastModifiedAt", "ga"));
  assign(details, "lastModifiedBy", optionalString(context, "lastModifiedBy", "properties.lastModifiedBy", "ga", 512));
  assign(details, "isQuarantined", optionalBoolean(context, "isQuarantined", "properties.isQuarantined", maturity(context, "isQuarantined")));
  assign(details, "quarantinedAt", optionalDate(context, "quarantinedAt", "properties.quarantinedAt", "preview"));
  assign(details, "isManaged", optionalBoolean(context, "isManaged", "properties.isManaged", maturity(context, "isManaged")));
  for (const key of ["schemaName", "createdIn", "environmentType", "environmentGroup", "environmentGroupId", "orchestration", "model", "authentication"] as const) {
    assign(details, key, optionalString(context, key, `properties.${key}`, maturity(context, key), 512));
  }
  assign(details, "isWebSearchEnabledForKnowledge", optionalBoolean(context, "isWebSearchEnabledForKnowledge", "properties.isWebSearchEnabledForKnowledge", "preview"));
  projectAgentObservations(context, details);
  const channels = optionalStringArray(context, "channels", "properties.channels", "preview", 50);
  if (channels) details.channels = channels;
  const connectorKey = "powerPlatformConnectors";
  const supportsConnectorDetails = context.schema.has(connectorKey);
  const connectorDetailsSupplied = supportsConnectorDetails && Object.hasOwn(context.properties, connectorKey) && context.properties[connectorKey] !== null;
  const connectors = supportsConnectorDetails ? resourceConnectors(context) : undefined;
  if (connectors !== undefined) details.connectors = connectors;
  const supportsCapabilityCounts = context.schema.has("capabilitiesCounts");
  const counts = supportsCapabilityCounts && isRecord(context.properties.capabilitiesCounts) ? context.properties.capabilitiesCounts : undefined;
  if (supportsCapabilityCounts && context.properties.capabilitiesCounts !== undefined && context.properties.capabilitiesCounts !== null && !counts) omitCapability(context);
  if (counts) {
    const connectorCount = safeCount(counts.distinctPowerPlatformConnectors);
    const operationCount = safeCount(counts.distinctPowerPlatformConnectorsOperations);
    for (const key of ["distinctPowerPlatformConnectors", "distinctPowerPlatformConnectorsOperations"]) {
      if (counts[key] !== undefined && counts[key] !== null && safeCount(counts[key]) === undefined) omitCapability(context);
    }
    if (connectorCount !== undefined) details.distinctPowerPlatformConnectors = connectorCount;
    if (operationCount !== undefined) details.distinctPowerPlatformConnectorsOperations = operationCount;
    const flowCount = observedCount(counts, "distinctFlows");
    if (flowCount !== undefined) {
      details.distinctFlows = flowCount;
      context.provenance.distinctFlows = { sourceSystem: "power_platform", path: "properties.capabilitiesCounts.distinctFlows", maturity: "observed" };
    }
    context.provenance.capabilityCounts = { sourceSystem: "power_platform", path: "properties.capabilitiesCounts", maturity: "preview" };
    const retainedConnectors = details.connectors?.length ?? 0;
    const retainedOperations = details.connectors?.reduce((sum, connector) => sum + (connector.operations?.length ?? 0), 0) ?? 0;
    if (connectorCount !== undefined && connectorCount !== retainedConnectors || operationCount !== undefined && operationCount !== retainedOperations) details.capabilityDetailsTruncated = true;
    context.omittedCount += Object.keys(counts).filter(key => !["distinctPowerPlatformConnectors", "distinctPowerPlatformConnectorsOperations", "distinctFlows"].includes(key)).length;
  }
  if (context.capabilityDetailsTruncated) details.capabilityDetailsTruncated = true;
  if (connectors?.length === maximumConnectors && details.distinctPowerPlatformConnectors === undefined
    || context.retainedOperations === maximumOperations && details.distinctPowerPlatformConnectorsOperations === undefined) details.capabilityDetailsTruncated = true;
  if (supportsConnectorDetails) details.connectorDetailsStatus = !connectorDetailsSupplied ? "not_supplied" : details.capabilityDetailsTruncated ? "partial" : "complete";
  return details;
}

function projectAgentObservations(context: ProjectionContext, details: PowerPlatformResourceDetails) {
  if (!context.schema.has("sharedWithViewers")) return;
  const sharing: Record<string, unknown> = {};
  for (const [property, role, fields] of [
    ["sharedWithViewers", "viewers", ["entireTenant", "userCount", "groupCount"]],
    ["sharedWithEditors", "editors", ["userCount", "groupCount"]],
  ] as const) {
    if (!Object.hasOwn(context.properties, property)) continue;
    sharing[role] = observedObject(context, property, fields);
    context.provenance[`makerSharing.${role}`] = { sourceSystem: "power_platform", path: `properties.${property}`, maturity: "preview" };
    if (isRecord(sharing[role])) for (const field of Object.keys(sharing[role])) {
      context.provenance[`makerSharing.${role}.${field}`] = { sourceSystem: "power_platform", path: `properties.${property}.${field}`, maturity: "preview" };
    }
  }
  if (!isMakerSharing(sharing)) invalidObservation("makerSharing", sharing);
  if (Object.keys(sharing).length) details.makerSharing = sharing;
  for (const property of ["harness", "titleId"] as const) {
    if (!Object.hasOwn(context.properties, property)) continue;
    const value = context.properties[property];
    if (value !== null && !validText(value, 512)) invalidObservation(property, value);
    details[property] = value;
    context.provenance[property] = { sourceSystem: "power_platform", path: `properties.${property}`, maturity: "observed" };
  }
  const instructions = observedCount(context.properties, "instructionsCharactersCount");
  if (instructions !== undefined) {
    details.instructionsCharactersCount = instructions;
    context.provenance.instructionsCharactersCount = { sourceSystem: "power_platform", path: "properties.instructionsCharactersCount", maturity: "observed" };
  }
  if (Object.hasOwn(context.properties, "componentsCounts")) {
    const components = observedObject(context, "componentsCounts", [...agentComponentCountFields, "knowledgeByType"]);
    if (!isAgentComponentCounts(components)) invalidObservation("componentsCounts", components);
    details.componentsCounts = components;
    context.provenance.componentsCounts = { sourceSystem: "power_platform", path: "properties.componentsCounts", maturity: "observed" };
  }
  for (const [property, field] of [["flows", "flowReferenceCount"], ["triggers", "triggerCount"]] as const) {
    if (!Object.hasOwn(context.properties, property)) continue;
    const value = context.properties[property];
    if (value !== null && !Array.isArray(value)) invalidObservation(property, value);
    details[field] = value === null ? null : value.length;
    context.provenance[field] = { sourceSystem: "power_platform", path: `properties.${property}.length`, maturity: "observed" };
  }
}

function observedObject(context: ProjectionContext, property: string, fields: readonly string[]) {
  const value = context.properties[property];
  if (value === null) return null;
  if (!isRecord(value)) invalidObservation(property, value);
  context.omittedCount += Object.keys(value).filter(key => !fields.includes(key)).length;
  return Object.fromEntries(fields.filter(field => Object.hasOwn(value, field)).map(field => [field, structuredClone(value[field])]));
}

function observedCount(value: Record<string, unknown>, field: string) {
  if (!Object.hasOwn(value, field)) return undefined;
  const count = value[field];
  if (!isNullableInventoryCount(count)) invalidObservation(field, count);
  return count;
}

function invalidObservation(field: string, value: unknown): never {
  throw new InventorySchemaError("Power Platform inventory returned invalid agent observation metadata.", {
    reason: "invalid_resource", field, actualType: valueType(value),
  });
}

function resourceConnectors(context: ProjectionContext): InventoryConnector[] | undefined {
  const value = context.properties.powerPlatformConnectors;
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) { context.omittedCount += 1; context.capabilityDetailsTruncated = true; return undefined; }
  if (value.length > maximumConnectors) { context.omittedCount += value.length - maximumConnectors; context.capabilityDetailsTruncated = true; }
  const connectors = value.slice(0, maximumConnectors).flatMap(entry => {
    if (!isRecord(entry) || !validText(entry.connectorId, 512)) { context.omittedCount += 1; context.capabilityDetailsTruncated = true; return []; }
    context.omittedCount += Object.keys(entry).filter(key => !["connectorId", "operations"].includes(key)).length;
    const operations = parseOperations(context, entry.operations);
    return [{ connectorId: entry.connectorId, ...(operations === undefined ? {} : { operations }) }];
  });
  context.provenance.connectors = { sourceSystem: "power_platform", path: "properties.powerPlatformConnectors", maturity: "preview" };
  return connectors;
}

function parseOperations(context: ProjectionContext, value: unknown) {
  if (value === undefined || value === null) { context.capabilityDetailsTruncated = true; return undefined; }
  if (!Array.isArray(value)) { context.omittedCount += 1; context.capabilityDetailsTruncated = true; return undefined; }
  const remaining = Math.max(maximumOperations - context.retainedOperations, 0);
  if (value.length > remaining) { context.omittedCount += value.length - remaining; context.capabilityDetailsTruncated = true; }
  const operations = value.slice(0, remaining).flatMap(entry => {
    if (!isRecord(entry) || !validText(entry.operationId, 512)) { context.omittedCount += 1; context.capabilityDetailsTruncated = true; return []; }
    const operation: InventoryConnectorOperation = { operationId: entry.operationId };
    const values = {
      usedAs: ["Tool", "Topic Tool", "Knowledge"],
      whenCanBeUsed: ["Anytime", "ViaDirectReferenceOnly", "Conditional"],
      connectionProvider: ["User", "Maker"],
    };
    for (const key of ["usedAs", "whenCanBeUsed", "connectionProvider"] as const) {
      if (typeof entry[key] === "string" && values[key].includes(entry[key])) operation[key] = entry[key];
      else if (entry[key] !== undefined && entry[key] !== null) omitCapability(context);
    }
    if (typeof entry.createdBy === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(entry.createdBy)) operation.createdBy = entry.createdBy;
    else if (entry.createdBy !== undefined && entry.createdBy !== null) omitCapability(context);
    for (const key of ["isEnabled", "requiresEndUserConsent"] as const) {
      if (typeof entry[key] === "boolean") operation[key] = entry[key];
      else if (entry[key] !== undefined && entry[key] !== null) omitCapability(context);
    }
    context.omittedCount += Object.keys(entry).filter(key => !["operationId", "createdBy", "usedAs", "isEnabled", "requiresEndUserConsent", "whenCanBeUsed", "connectionProvider"].includes(key)).length;
    return [operation];
  });
  context.retainedOperations += operations.length;
  return operations;
}

function omitCapability(context: ProjectionContext) {
  context.omittedCount += 1;
  context.capabilityDetailsTruncated = true;
}

function identifier(context: ProjectionContext, property: string, kind: InventoryIdentifier["kind"]): InventoryIdentifier[] {
  const value = optionalString(context, property, `properties.${property}`, "ga", 512);
  return value ? [{ kind, value }] : [];
}

function optionalString(context: ProjectionContext, property: string, path: string, fieldMaturity: InventoryFieldMaturity, maximumLength: number) {
  if (!context.schema.has(property)) return null;
  const value = context.properties[property];
  if (value === undefined || value === null) return null;
  if (!validText(value, maximumLength)) { context.omittedCount += 1; return null; }
  context.provenance[property] = { sourceSystem: "power_platform", path, maturity: fieldMaturity };
  return value.slice(0, maximumLength);
}

function optionalDate(context: ProjectionContext, property: string, path: string, fieldMaturity: InventoryFieldMaturity) {
  const value = optionalString(context, property, path, fieldMaturity, 64);
  if (!value) return null;
  const match = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(Z|[+-](\d{2}):([0-5]\d))$/.exec(value);
  const date = new Date(value);
  if (!match || match[1].startsWith("0000") || Number(match[3]) > 14 || Number(match[3]) === 14 && Number(match[4]) !== 0
    || !Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999
    || new Date(`${match[1]}T00:00:00Z`).toISOString().slice(0, 10) !== match[1]) {
    context.omittedCount += 1;
    delete context.provenance[property];
    return null;
  }
  const fraction = value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1];
  // Normalize the timezone without discarding provider evidence below millisecond precision.
  return fraction ? date.toISOString().replace(/\.\d{3}Z$/, `.${fraction.padEnd(3, "0")}Z`) : date.toISOString();
}

function optionalBoolean(context: ProjectionContext, property: string, path: string, fieldMaturity: InventoryFieldMaturity) {
  if (!context.schema.has(property)) return undefined;
  const value = context.properties[property];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") { context.omittedCount += 1; return undefined; }
  context.provenance[property] = { sourceSystem: "power_platform", path, maturity: fieldMaturity };
  return value;
}

function optionalStringArray(context: ProjectionContext, property: string, path: string, fieldMaturity: InventoryFieldMaturity, limit: number) {
  if (!context.schema.has(property)) return undefined;
  const value = context.properties[property];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) { context.omittedCount += 1; return undefined; }
  const retained = value.slice(0, limit).flatMap(entry => unicodeText(entry) && entry.length <= 512 ? [entry] : []);
  context.omittedCount += value.length - retained.length;
  if (value.length && !retained.length) return undefined;
  context.provenance[property] = { sourceSystem: "power_platform", path, maturity: fieldMaturity };
  return retained;
}

function deriveAgentKind(type: PowerPlatformResourceType, createdIn: string | null) {
  if (type === "microsoft.copilotstudio/agents") {
    const authoringTool = derivePowerPlatformAuthoringTool(type, createdIn);
    return authoringTool === "Microsoft 365 Copilot Agent Builder" ? "agent_builder_agent"
      : authoringTool === "Copilot Studio" ? "copilot_studio_agent" : "agent";
  }
  return "not_agent";
}

function deriveLifecycle(type: PowerPlatformResourceType, rawLastPublishedAt: unknown, supplied: boolean, lastPublishedAt: string | null): PowerPlatformResource["lifecycle"] {
  if (type !== "microsoft.copilotstudio/agents") return "not_applicable";
  if (lastPublishedAt) return "published";
  if (supplied && (rawLastPublishedAt === null || rawLastPublishedAt === "")) return "draft";
  return "unknown";
}

function assign<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | null | undefined) {
  if (value !== null && value !== undefined) target[key] = value;
}

function maturity(context: ProjectionContext, property: string): InventoryFieldMaturity {
  return context.schema.get(property) ?? "ga";
}

function fields(fieldMaturity: InventoryFieldMaturity, ...properties: string[]) {
  return new Map(properties.map(property => [property, fieldMaturity] as const));
}

function schema(...parts: ReadonlyMap<string, InventoryFieldMaturity>[]) {
  return new Map(parts.flatMap(part => [...part]));
}

function retryAfterMs(value: string | null) {
  if (value === null) return undefined;
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const milliseconds = Math.ceil(Number(text) * 1_000);
    // An unrepresentable cooldown must fail closed rather than become shorter fallback backoff.
    return Number.isSafeInteger(milliseconds) ? milliseconds : Number.MAX_SAFE_INTEGER;
  }
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)) return undefined;
  const date = Date.parse(text);
  return Number.isFinite(date) && new Date(date).toUTCString() === text ? Math.max(date - Date.now(), 0) : undefined;
}

function disposeResponse(response: Response) {
  try { void response.body?.cancel().catch(() => undefined); } catch { /* The failed provider stream is already unusable. */ }
}

function safeCount(value: unknown) {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

function validText(value: unknown, maximumLength: number): value is string {
  return unicodeText(value) && value.length > 0 && value.length <= maximumLength;
}

function unicodeText(value: unknown): value is string {
  // JSON escapes can contain NUL or lone surrogates even in a valid UTF-8 response; JSONB cannot store them.
  return typeof value === "string" && !/[\0\uD800-\uDFFF]/u.test(value);
}

function invalidContinuationToken(value: unknown): never {
  throw new InventorySchemaError("Power Platform inventory returned an invalid continuation token.", {
    reason: "invalid_continuation", field: "skipToken", actualType: valueType(value),
    ...(typeof value === "string" ? { length: value.length, maximumLength: 4_096 } : {}),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}