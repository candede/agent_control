import { AppError, errorName, errorTelemetry, isTimeoutError } from "../errors.js";
import { allowlistedPackage, parsePackageObservationJson } from "./packageObservation.js";
import { canonicalAccessEntities, capturePackageMutationState, packageMutationStatesEqual, requirePreservablePackageAccessScope, validatePackageAccessUpdate, type PackageMutationState } from "./packageMutationState.js";
import { boundedProviderJson, boundedProviderText, parseProviderContractJson } from "./providerJson.js";
import { operationalLog } from "./telemetry.js";
import type { PackageReadStage, PackageScanDiagnostics } from "./packageScanDiagnostics.js";
import { packageRefreshExecutionDeadlineMs } from "./packageRefreshPolicy.js";
import { randomUUID } from "node:crypto";
import { types } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { isPackageAccessEntity, isPackageId, normalizePackageStatus, packageAccessCollectionLimit } from "../types/copilotPackage.js";
import { inventoryLimits, type InventoryPage } from "../types/inventoryRecords.js";
import { dataLimits } from "../db/dataBounds.js";
import type {
  CopilotPackage,
  CopilotPackageDetail,
  GraphCollectionResponse,
  PackageAccessEntity,
  PackageAccessUpdate,
  PackageAccessUpdateResult,
} from "../types/copilotPackage.js";

const graphV1 = "https://graph.microsoft.com/v1.0";
const graphBeta = "https://graph.microsoft.com/beta";
export const packageReadTimeoutMs = 30_000;
export const packageInventoryReadPolicy = {
  minimumReadIntervalMs: 0, throttledReadIntervalMs: 250, maxThrottleAttempts: 6,
  adaptivePacing: true, maxRetryAfterMs: packageRefreshExecutionDeadlineMs,
};
const maximumRetryAfterMs = 5 * 60_000;
const copilotFilter = "supportedHosts/any(h:h eq 'Copilot')";
const defaultRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 2_000,
  maxDelayMs: 30_000,
  throttleBaseDelayMs: 30_000,
  maxThrottleDelayMs: 120_000,
  minimumReadIntervalMs: 0,
  throttledReadIntervalMs: 0,
  adaptivePacing: false,
  maximumReadIntervalMs: 2_000,
  pacingRecoveryMs: 60_000,
  maxRetryAfterMs: maximumRetryAfterMs,
  now: () => performance.now(),
  delay: (ms: number, signal?: AbortSignal) => delay(ms, undefined, { signal }),
};

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

type RetryPolicy = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  maxThrottleAttempts: number;
  throttleBaseDelayMs: number;
  maxThrottleDelayMs: number;
  minimumReadIntervalMs: number;
  throttledReadIntervalMs: number;
  adaptivePacing: boolean;
  maximumReadIntervalMs: number;
  pacingRecoveryMs: number;
  maxRetryAfterMs: number;
  now: () => number;
  delay: (delayMs: number, signal?: AbortSignal) => Promise<unknown>;
};

export type PackageReadOptions = {
  signal?: AbortSignal;
  /** Absolute caller execution deadline in Unix milliseconds. */
  executionDeadlineAt?: number;
  assertCurrent?: () => void;
  beforeRequest?: () => Promise<void>;
  /** Final authority gate after token preparation, repeated for each physical read attempt. */
  beforeDispatch?: () => Promise<void>;
  correlationId?: string;
  diagnostics?: PackageScanDiagnostics;
  getAccessToken?: () => Promise<string>;
  retryThrottlingUntilAborted?: boolean;
  onProgress?: (progress: { pages: number; observedCount: number; totalRecords?: number | null }) => void | Promise<void>;
  onRetry?: (retry: { attempt: number; retryDelayMs: number; throttled: boolean }) => void | Promise<void>;
};

export type PackageMutationOptions = {
  signal?: AbortSignal;
  /** Absolute caller execution deadline in Unix milliseconds. */
  executionDeadlineAt?: number;
  correlationId: string;
  assertCurrent?: () => void;
};

export type PackageReadbackOptions = PackageReadOptions & {
  maxAttempts?: number;
  delayMs?: number;
  delay?: (delayMs: number) => Promise<unknown>;
};

export class GraphPackagesClient {
  private fetcher: FetchLike;
  private retryPolicy: RetryPolicy;
  private readQueue: Promise<void> = Promise.resolve();
  private nextReadAt = 0;
  private cooldownUntil = 0;
  private cooldownError?: AppError;
  private readIntervalMs: number;
  private pacingGeneration = 0;
  private pacingRecoveryAt?: number;

  constructor(
    fetcher: FetchLike = fetch,
    retryPolicy: Partial<RetryPolicy> = {},
  ) {
    this.fetcher = fetcher;
    this.retryPolicy = { ...defaultRetryPolicy, ...retryPolicy,
      maxThrottleAttempts: retryPolicy.maxThrottleAttempts ?? retryPolicy.maxAttempts ?? defaultRetryPolicy.maxAttempts };
    this.readIntervalMs = this.retryPolicy.minimumReadIntervalMs;
  }

  async checkCatalogAccess(accessToken: string, signal?: AbortSignal, assertCurrent?: () => void) {
    const budget = this.readBudget({ signal, assertCurrent });
    try {
      budget.assertCurrent();
      const page = await this.requestReadWithRetry<GraphCollectionResponse<CopilotPackage>>(
        buildCopilotAgentsListUrl(),
        accessToken,
        budget,
        "catalog",
      );
      budget.assertCurrent();
      if (!page || !Array.isArray(page.value)) throw new AppError(502, "provider_schema", "Package access check returned an invalid collection.");
      page.value.forEach(allowlistedPackage);
      budget.assertCurrent();
    } finally { budget.dispose(); }
  }

  async *catalogPages(accessToken: string, options: PackageReadOptions & {
    visit: (token: string) => Promise<void>;
  }): AsyncGenerator<InventoryPage<CopilotPackageDetail>> {
    const budget = this.readBudget(options, inventoryLimits.graphDeadlineMs);
    options = { ...options, ...budget.options };
    try {
      let url: string | undefined = buildCopilotAgentsListUrl();
      let pages = 0;
      let observed = 0;
      const visited = new Set<string>();
      const identities = new Set<string>();
      while (url) {
        budget.assertCurrent();
        if (++pages > inventoryLimits.pages) throw new AppError(502, "provider_page_limit", "Inventory exceeds 10000 pages.");
        url = catalogUrl(url, pages > 1);
        if (visited.has(url)) throw new AppError(502, "provider_continuation", "Package catalog repeated a continuation.");
        visited.add(url);
        await budget.callback(() => options.visit(url!));
        budget.assertCurrent();
        const started = this.retryPolicy.now();
        const page: GraphCollectionResponse<CopilotPackage> & { "@odata.count"?: number } = await this.requestReadWithRetry(
          url, accessToken, budget, "catalog");
        budget.assertCurrent();
        if (!page || !Array.isArray(page.value)) throw new AppError(502, "provider_schema", "Invalid catalog page.");
        const count = page["@odata.count"];
        if (count !== undefined) {
          if (!Number.isSafeInteger(count) || count < 0) throw new AppError(502, "provider_schema", "Invalid catalog count.");
        }
        const next: string | undefined = page["@odata.nextLink"];
        if (next !== undefined && (typeof next !== "string" || !next.trim() || next.length > 8192)) {
          throw new AppError(502, "provider_schema", "Invalid catalog continuation.");
        }
        const nextUrl = next === undefined ? undefined : catalogUrl(next, true);
        if (nextUrl && visited.has(nextUrl)) throw new AppError(502, "provider_continuation", "Package catalog repeated a continuation.");
        observed += page.value.length;
        if (observed > inventoryLimits.sourceRows) throw new AppError(502, "provider_result_limit", "Inventory exceeds 100000 source records.");
        options.diagnostics?.catalogPage(page.value, pages, next !== undefined, this.retryPolicy.now() - started, count);
        const records = page.value.map(allowlistedPackage);
        for (const record of records) {
          if (identities.has(record.id)) throw new AppError(502, "provider_schema", "Package catalog repeated an exact package identity.");
          identities.add(record.id);
        }
        // This filtered endpoint is server-paged: only the opaque nextLink establishes completion.
        const expected = next === undefined ? observed : null;
        budget.assertCurrent();
        yield { token: url, nextToken: nextUrl ?? null, records,
          rawCount: page.value.length, expectedCount: expected, page: pages };
        budget.assertCurrent();
        if (options.onProgress) await budget.callback(async () =>
          options.onProgress!({ pages, observedCount: observed, totalRecords: expected }));
        budget.assertCurrent();
        url = nextUrl;
      }
    } finally { budget.dispose(); }
  }

  async getPackageDetails(accessToken: string, id: string, options: PackageReadOptions = {}) {
    const budget = this.readBudget(options);
    try {
      budget.assertCurrent();
      requirePackageId(id);
      const observation = await this.requestReadWithRetry<CopilotPackageDetail>(
        `${graphV1}/copilot/admin/catalog/packages/${encodeURIComponent(id)}`,
        accessToken,
        budget,
        "identity",
      );
      budget.assertCurrent();
      const details = allowlistedPackage(observation);
      requirePackageIdentity(details, id);
      budget.assertCurrent();
      return details;
    } finally { budget.dispose(); }
  }

  private readBudget(options: PackageReadOptions, maximumDurationMs = Infinity) {
    if ((options.executionDeadlineAt !== undefined && !Number.isSafeInteger(options.executionDeadlineAt))
      || (options.retryThrottlingUntilAborted && (!options.signal || options.executionDeadlineAt === undefined))) {
      throw new AppError(500, "invalid_read_policy", "Extended throttling retries require a caller execution deadline and cancellation signal.");
    }
    const ordinaryDuration = this.retryPolicy.maxRetryAfterMs + packageReadTimeoutMs;
    const callerDuration = options.executionDeadlineAt === undefined ? Infinity : options.executionDeadlineAt - Date.now();
    const duration = Math.min(maximumDurationMs,
      options.retryThrottlingUntilAborted ? callerDuration : Math.min(ordinaryDuration, callerDuration));
    return new PackageReadBudget(options, duration, this.retryPolicy.now,
      callerDuration <= duration ? new DOMException("Package execution deadline expired.", "TimeoutError")
        : new AppError(504, "provider_timeout", "Microsoft Graph package read exceeded its logical read budget."));
  }

  async blockPackage(accessToken: string, id: string, options: PackageMutationOptions = { correlationId: randomUUID() }) {
    assertPackageAuthority(options);
    requirePackageId(id);
    await this.requestMutationOnce<void>(
      `${graphBeta}/copilot/admin/catalog/packages/${encodeURIComponent(id)}/block`,
      accessToken,
      { method: "POST" },
      options,
    );
    assertPackageAuthority(options);
  }

  async unblockPackage(accessToken: string, id: string, options: PackageMutationOptions = { correlationId: randomUUID() }) {
    assertPackageAuthority(options);
    requirePackageId(id);
    await this.requestMutationOnce<void>(
      `${graphBeta}/copilot/admin/catalog/packages/${encodeURIComponent(id)}/unblock`,
      accessToken,
      { method: "POST" },
      options,
    );
    assertPackageAuthority(options);
  }

  async patchPackageAccess(
    accessToken: string,
    id: string,
    payload: Record<string, PackageAccessEntity[]>,
    options: PackageMutationOptions = { correlationId: randomUUID() },
  ) {
    assertPackageAuthority(options);
    requirePackageId(id);
    const body = JSON.stringify(validatePackageAccessPayload(payload));
    await this.requestMutationOnce<void>(
      `${graphBeta}/copilot/admin/catalog/packages/${encodeURIComponent(id)}`,
      accessToken,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body,
      },
      options,
    );
    assertPackageAuthority(options);
  }

  private async request<T>(
    url: string,
    accessToken: string,
    init: RequestInit = {},
    options: PackageReadOptions | PackageMutationOptions = {},
    readBudget?: PackageReadBudget,
    observeResponse?: (response: Response) => void,
    observeDispatch?: () => void,
  ): Promise<T> {
    const target = URL.parse(url);
    if (!target || target.origin !== "https://graph.microsoft.com" || target.username || target.password || !/^\/(v1\.0|beta)\/copilot\/admin\/catalog\/packages(?:\/|$)/.test(target.pathname)) {
      throw new AppError(502, "invalid_provider_link", "Provider pagination left the documented package endpoint.");
    }
    const correlationId = options.correlationId ?? randomUUID();
    const read = !init.method || init.method === "GET";
    const budget = new PackageReadBudget(options, read
      ? Math.min(packageReadTimeoutMs, readBudget?.remainingMs() ?? packageReadTimeoutMs)
      : Math.min(10_000, options.executionDeadlineAt === undefined ? Infinity : options.executionDeadlineAt - Date.now()),
      this.retryPolicy.now, undefined, readBudget);
    const { signal } = budget;
    let response: Response | undefined;
    let undeliveredResponse: Response | undefined;
    let responseDisposed = false;
    const disposeResponse = (value: Response) => {
      if (responseDisposed) return;
      responseDisposed = true;
      try { void value.body?.cancel().catch(() => undefined); }
      catch { /* Disposal cannot replace cancellation or provider diagnostics. */ }
    };
    let removeAbort = () => {};
    try {
      budget.assertCurrent();
      observeDispatch?.();
      const fetching = this.fetcher(url, {
        ...init,
        signal,
        redirect: "error",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          "client-request-id": correlationId,
          "return-client-request-id": "true",
          ...init.headers,
        },
      });
      const aborted = new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
        removeAbort = () => signal.removeEventListener("abort", onAbort);
      });
      void fetching.then(value => {
        undeliveredResponse = value;
        observeResponse?.(value);
        try { budget.assertCurrent(); } catch { disposeResponse(value); }
      }, () => undefined);
      response = await Promise.race([fetching, aborted]);
      undeliveredResponse = undefined;
      try {
        budget.assertCurrent();
      } catch (error) {
        disposeResponse(response);
        throw error;
      }
      if (!response.ok) throw await graphError(response, signal);
      if (response.status === 204) return undefined as T;
      const result = await boundedProviderJson<T>(response, signal, undefined, parsePackageObservationJson);
      budget.assertCurrent();
      return result;
    } catch (error) {
      if (undeliveredResponse) {
        response = undeliveredResponse;
        disposeResponse(response);
      }
      readBudget?.assertCurrent();
      if (!readBudget) assertPackageAuthority(options);
      // Error-body timeouts must not erase an observed denial or throttle cooldown.
      if ((signal.aborted && isTimeoutError(signal.reason) || isTimeoutError(error)) && response && !response.ok) throw graphResponseError(response);
      if (signal.aborted && isTimeoutError(signal.reason) || isTimeoutError(error)) {
        throw new AppError(504, "provider_timeout", read
          ? "Microsoft Graph did not finish the package read within 30 seconds."
          : "Microsoft Graph did not finish the package mutation within ten seconds.");
      }
      signal.throwIfAborted();
      if (error instanceof AppError) throw error;
      throw new AppError(502, "provider_network_error", "Microsoft Graph could not be reached.");
    } finally {
      removeAbort();
      budget.dispose();
    }
  }

  private async requestReadWithRetry<T>(
    url: string,
    accessToken: string,
    budget: PackageReadBudget,
    stage: PackageReadStage,
  ): Promise<T> {
    const pathname = URL.parse(url)?.pathname;
    const options = budget.options;
    let throttleFailures = 0;
    let transientFailures = 0;
    let dispatchedAttempts = 0;
    for (let attempt = 1; ; attempt += 1) {
      let phase: "token" | "admission" | "request" = "token";
      let observedThrottle: AppError | undefined;
      let pacingGeneration = this.pacingGeneration;
      try {
        budget.assertCurrent();
        let currentToken = await this.tokenForRead(accessToken, budget);
        budget.assertCurrent();
        let tokenObtainedAt = this.retryPolicy.now();
        phase = "admission";
        const queuedAt = this.retryPolicy.now();
        let dispatchedAt: number | undefined;
        let admitted: { request: Promise<T> };
        try {
          admitted = await this.waitForReadSlot(budget, async () => {
            const renewAgedToken = async () => {
              if (!options.getAccessToken || this.retryPolicy.now() - tokenObtainedAt < packageReadTimeoutMs) return;
              // Keep the queue position: rejoining a busy queue can age every renewed token.
              phase = "token";
              currentToken = await this.tokenForRead(accessToken, budget);
              tokenObtainedAt = this.retryPolicy.now();
              phase = "admission";
            };
            budget.assertCurrent();
            await renewAgedToken();
            if (options.beforeRequest) await budget.callback(() => options.beforeRequest!());
            await renewAgedToken();
            for (;;) {
              if (options.beforeDispatch) await budget.callback(() => options.beforeDispatch!());
              if (!options.getAccessToken || this.retryPolicy.now() - tokenObtainedAt < packageReadTimeoutMs) break;
              // A slow final fence can age a token too; renew it without repeating preparation.
              await renewAgedToken();
            }
            budget.assertCurrent();
          }, async () => {
            phase = "request";
            let requestStartedAt: number | undefined;
            const readIntervalMs = this.readIntervalMs;
            pacingGeneration = this.pacingGeneration;
            try {
              return await this.request<T>(url, currentToken, {}, options, budget, response => {
                if (response.status !== 429) return;
                observedThrottle = graphResponseError(response);
                this.throttleReadPacing(observedThrottle, getRetryDelayMs(observedThrottle, throttleFailures + 1, this.retryPolicy), stage, pacingGeneration);
                if (!budget.signal.aborted) options.diagnostics?.recordThrottle(stage);
              }, () => {
                dispatchedAttempts += 1;
                requestStartedAt = this.retryPolicy.now();
                dispatchedAt = requestStartedAt;
                this.nextReadAt = requestStartedAt + this.readIntervalMs;
              });
            } finally {
              if (requestStartedAt !== undefined) options.diagnostics?.recordAttempt(stage,
                this.retryPolicy.now() - requestStartedAt, dispatchedAttempts, readIntervalMs);
            }
          });
        } finally {
          options.diagnostics?.recordWait(stage, "admissionWaitMs", (dispatchedAt ?? this.retryPolicy.now()) - queuedAt);
        }
        phase = "request";
        budget.assertCurrent();
        const result = await admitted.request;
        this.recoverReadPacing(stage, pacingGeneration);
        return result;
      } catch (error) {
        budget.assertCurrent();
        if (phase === "admission") throw error;
        const throttled = error instanceof AppError && isGraphThrottling(error);
        if (throttled && observedThrottle && this.cooldownError === observedThrottle) this.cooldownError = error;
        if (throttled && phase === "request" && !observedThrottle) options.diagnostics?.recordThrottle(stage);
        const retryable = error instanceof AppError && isRetryableGraphError(error);
        const failureCount = throttled ? ++throttleFailures : ++transientFailures;
        const retryDelayMs = retryable ? getRetryDelayMs(error, failureCount, this.retryPolicy,
          options.retryThrottlingUntilAborted ? budget.remainingMs() : this.retryPolicy.maxRetryAfterMs) : undefined;
        const retryAfterMs = error instanceof AppError ? retryAfterFromDetails(error.details) : undefined;
        if (throttled && phase === "request" && !observedThrottle) this.throttleReadPacing(error, retryDelayMs, stage, pacingGeneration);
        const fields = {
          provider: "graph_packages",
          stage: pathname === undefined ? "pagination" : stage,
          attempt,
          readIntervalMs: this.readIntervalMs,
          ...(retryable ? { retryAfterMs, retryDelaySource: retryAfterMs === undefined ? "fallback" : "retry_after" } : {}),
          ...graphErrorTelemetry(error),
        };
        if (
          !retryable ||
          failureCount >= (throttled
            ? options.retryThrottlingUntilAborted ? Infinity : this.retryPolicy.maxThrottleAttempts
            : this.retryPolicy.maxAttempts) ||
          retryDelayMs === undefined || retryDelayMs >= budget.remainingMs()
        ) {
          operationalLog("warn", "package_provider_read_failed", fields);
          throw error;
        }

        operationalLog("warn", "package_provider_read_retry", { ...fields, retryDelayMs });
        if (options.onRetry) await budget.callback(async () => options.onRetry!({ attempt, retryDelayMs, throttled }));
        budget.assertCurrent();
        if (retryDelayMs >= budget.remainingMs()) throw error;
        const retryStartedAt = this.retryPolicy.now();
        try {
          await budget.wait(this.retryPolicy.delay, retryDelayMs);
        } finally {
          options.diagnostics?.recordWait(stage, "retryWaitMs", this.retryPolicy.now() - retryStartedAt);
        }
      }
    }
  }

  private async tokenForRead(accessToken: string, budget: PackageReadBudget) {
    const getAccessToken = budget.options.getAccessToken;
    if (!getAccessToken) return accessToken;
    return budget.callback(getAccessToken);
  }

  private throttleReadPacing(error: AppError, retryDelayMs: number | undefined, stage: PackageReadStage, generation: number) {
    if (this.readIntervalMs === 0 && this.retryPolicy.throttledReadIntervalMs === 0) return;
    const previousInterval = this.readIntervalMs;
    if (this.retryPolicy.adaptivePacing && generation === this.pacingGeneration) {
      this.readIntervalMs = Math.max(this.retryPolicy.throttledReadIntervalMs,
        Math.min(this.retryPolicy.maximumReadIntervalMs, this.readIntervalMs * 2));
      this.pacingGeneration += 1;
    } else {
      this.readIntervalMs = Math.max(this.readIntervalMs, this.retryPolicy.throttledReadIntervalMs);
    }
    this.nextReadAt += this.readIntervalMs - previousInterval;
    this.pacingRecoveryAt = undefined;
    if (this.readIntervalMs !== previousInterval) operationalLog("info", "package_provider_pacing_changed", {
      provider: "graph_packages", stage, reason: "throttled", readIntervalMs: this.readIntervalMs,
    });
    const cooldownMs = retryDelayMs ?? retryAfterFromDetails(error.details);
    const now = this.retryPolicy.now();
    if (cooldownMs !== undefined && now + cooldownMs > this.cooldownUntil) {
      this.cooldownUntil = now + cooldownMs;
      this.cooldownError = error;
    }
  }

  private recoverReadPacing(stage: "catalog" | "identity", generation: number) {
    if (!this.retryPolicy.adaptivePacing || generation !== this.pacingGeneration
      || this.readIntervalMs <= this.retryPolicy.minimumReadIntervalMs) return;
    const now = this.retryPolicy.now();
    if (this.pacingRecoveryAt === undefined) this.pacingRecoveryAt = now + this.retryPolicy.pacingRecoveryMs;
    if (now < this.pacingRecoveryAt) return;
    this.readIntervalMs = this.readIntervalMs <= this.retryPolicy.throttledReadIntervalMs / 4
      ? this.retryPolicy.minimumReadIntervalMs
      : Math.max(this.retryPolicy.minimumReadIntervalMs, Math.floor(this.readIntervalMs * 0.8));
    this.pacingRecoveryAt = now + this.retryPolicy.pacingRecoveryMs;
    operationalLog("info", "package_provider_pacing_changed", {
      provider: "graph_packages", stage, reason: "recovering", readIntervalMs: this.readIntervalMs,
    });
  }

  private async waitForReadSlot<T>(budget: PackageReadBudget,
    beforeAdmission: () => Promise<void>, dispatch: () => Promise<T>) {
    const options = budget.options;
    const dispatchRead = () => {
      const request = dispatch();
      // Admission must release after dispatch, not await the response; abandoned work stays observed.
      void request.catch(() => undefined);
      return { request };
    };
    if (this.readIntervalMs === 0 && this.retryPolicy.throttledReadIntervalMs === 0) {
      await beforeAdmission();
      budget.assertCurrent();
      return dispatchRead();
    }
    // The caller and queued work share one budget, including supported cooldowns.
    const admissionOptions = options;
    const admission = this.readQueue.then(async () => {
      budget.assertCurrent();
      for (;;) {
        const now = this.retryPolicy.now();
        const supportedWait = options.retryThrottlingUntilAborted ? budget.remainingMs() : this.retryPolicy.maxRetryAfterMs;
        if (this.cooldownUntil - now > supportedWait && this.cooldownError) throw this.cooldownError;
        const waitMs = Math.max(this.nextReadAt, this.cooldownUntil) - now;
        if (waitMs >= budget.remainingMs()) {
          if (this.cooldownError) throw this.cooldownError;
          throw new AppError(504, "provider_timeout", "Package read admission exceeds the logical read budget.");
        }
        if (waitMs > 0) {
          await budget.wait(this.retryPolicy.delay, waitMs);
          budget.assertCurrent();
          continue;
        }
        await beforeAdmission();
        budget.assertCurrent();
        // In-flight responses may extend the cooldown during token renewal or preparation.
        if (Math.max(this.nextReadAt, this.cooldownUntil) <= this.retryPolicy.now()) break;
      }
      budget.assertCurrent();
      return dispatchRead();
    });
    // A cancelled waiter must not reject the admission queue for other jobs.
    this.readQueue = admission.then(() => undefined, () => undefined);
    return waitForReadRetry(() => admission, 0, admissionOptions.signal);
  }

  private requestMutationOnce<T>(url: string, accessToken: string, init: RequestInit, options: PackageMutationOptions) {
    return this.request<T>(url, accessToken, init, options);
  }
}

export async function updatePackageAccess(
  client: Pick<GraphPackagesClient, "getPackageDetails" | "patchPackageAccess">,
  accessToken: string,
  id: string,
  update: PackageAccessUpdate,
  currentDetails?: CopilotPackageDetail,
  beforeWrite?: () => Promise<string | void>,
  mutationOptions?: PackageMutationOptions,
): Promise<PackageAccessUpdateResult> {
  assertPackageAuthority(mutationOptions ?? {});
  requirePackageId(id);
  validatePackageAccessUpdate(update);
  const property = accessCollectionProperty(update.target);
  const requested = deduplicateAccessEntities(update.principals);

  let details = currentDetails;
  try {
    details ??= await client.getPackageDetails(accessToken, id, mutationOptions);
  } finally { assertPackageAuthority(mutationOptions ?? {}); }
  requirePackageIdentity(details, id);
  if (details[property] === undefined) {
    throw new AppError(
      409,
      "incomplete_package_access_state",
      `Microsoft Graph did not return ${property}, so the current access assignment cannot be determined safely.`,
    );
  }
  const previous = deduplicateAccessEntities(details[property] ?? []);
  const currentScope = inferCurrentAccessScope(
    details,
    update.target,
    previous,
  );
  const desiredScope = update.scope === "none" ? "none" : "specific";
  let resulting = update.scope === "none" ? [] : requested;

  if (update.mode === "add") {
    if (currentScope === "all") {
      assertPackageAuthority(mutationOptions ?? {});
      return {
        changed: false,
        previousCount: previous.length,
        resultingCount: previous.length,
        principals: previous,
      };
    }

    if (currentScope === "unknown") {
      throw new AppError(
        409,
        "ambiguous_access_scope",
        "Current access could not be determined safely. Use replace mode.",
      );
    }

    resulting = currentScope === "none" ? requested : deduplicateAccessEntities(previous, requested);
  }

  if (
    currentScope === desiredScope &&
    sameAccessEntities(previous, resulting)
  ) {
    assertPackageAuthority(mutationOptions ?? {});
    return {
      changed: false,
      previousCount: previous.length,
      resultingCount: resulting.length,
      principals: resulting,
    };
  }

  const unselectedTarget = otherAccessTarget(update.target);
  const unselectedProperty = accessCollectionProperty(unselectedTarget);

  if (details[unselectedProperty] === undefined) {
    throw new AppError(
      409,
      "incomplete_package_access_state",
      `Microsoft Graph did not return ${unselectedProperty}, so the documented full access payload cannot be sent safely.`,
    );
  }

  const preserved = deduplicateAccessEntities(details[unselectedProperty]);
  if (inferCurrentAccessScope(details, unselectedTarget, preserved) === "unknown") {
    throw new AppError(
      409,
      "ambiguous_access_scope",
      "Current unselected access could not be determined safely. Refresh complete access state before retrying.",
    );
  }
  requirePreservablePackageAccessScope(unselectedTarget === "availability" ? details.availableTo : details.deployedTo, preserved);

  const payload = {
    allowedUsersAndGroups:
      update.target === "availability"
        ? resulting
        : preserved,
    acquireUsersAndGroups:
      update.target === "installation"
        ? resulting
        : preserved,
  };
  try {
    const dispatchToken = await beforeWrite?.() ?? accessToken;
    assertPackageAuthority(mutationOptions ?? {});
    if (mutationOptions) await client.patchPackageAccess(dispatchToken, id, payload, mutationOptions);
    else await client.patchPackageAccess(dispatchToken, id, payload);
  } finally { assertPackageAuthority(mutationOptions ?? {}); }

  return {
    changed: true,
    previousCount: previous.length,
    resultingCount: resulting.length,
    principals: resulting,
  };
}

export async function verifyPackageMutationConverged(
  client: Pick<GraphPackagesClient, "getPackageDetails">,
  accessToken: string,
  id: string,
  action: "block" | "unblock" | "update-availability" | "update-installation",
  expectedState: PackageMutationState,
  options: PackageReadbackOptions = {},
) {
  const maxAttempts = Math.min(Math.max(Math.trunc(options.maxAttempts ?? 4), 1), 20);
  const delayMs = Math.min(Math.max(Math.trunc(options.delayMs ?? 500), 0), 5_000);
  const wait = options.delay ?? defaultRetryPolicy.delay;
  let lastState: PackageMutationState | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    assertPackageAuthority(options);
    let details: CopilotPackageDetail;
    try {
      details = await client.getPackageDetails(accessToken, id, options);
    } finally { assertPackageAuthority(options); }
    requirePackageIdentity(details, id);
    lastState = capturePackageMutationState(details, action);
    const converged = packageMutationStatesEqual(lastState, expectedState);
    assertPackageAuthority(options);
    if (converged) return { details, state: lastState, readbackCount: attempt };
    if (attempt < maxAttempts && delayMs > 0) {
      const waitBudget = new PackageReadBudget(options,
        Math.min(delayMs + packageReadTimeoutMs,
          options.executionDeadlineAt === undefined ? Infinity : options.executionDeadlineAt - Date.now()), () => performance.now());
      try {
        await waitForReadRetry(wait, delayMs, waitBudget.signal);
        waitBudget.assertCurrent();
      } finally {
        waitBudget.dispose();
        assertPackageAuthority(options);
      }
    }
  }
  assertPackageAuthority(options);
  throw new AppError(409, "verification_inconclusive", "Microsoft Graph accepted the request but the expected package state did not converge within the bounded readback window.", { expectedState, lastState, readbackCount: maxAttempts });
}

function requirePackageIdentity(details: CopilotPackageDetail, id: string) {
  if (details.id !== id) throw new AppError(502, "target_mismatch", "Provider returned a different package identity.");
}

function sameAccessEntities(
  left: PackageAccessEntity[],
  right: PackageAccessEntity[],
) {
  if (left.length !== right.length) {
    return false;
  }

  const rightKeys = new Set(
    right.map(
      (entity) =>
        `${entity.resourceType.toLowerCase()}:${entity.resourceId}`,
    ),
  );

  return left.every((entity) =>
    rightKeys.has(
      `${entity.resourceType.toLowerCase()}:${entity.resourceId}`,
    ),
  );
}

function accessCollectionProperty(target: PackageAccessUpdate["target"]) {
  return target === "availability"
    ? ("allowedUsersAndGroups" as const)
    : ("acquireUsersAndGroups" as const);
}

function otherAccessTarget(target: PackageAccessUpdate["target"]) {
  return target === "availability"
    ? ("installation" as const)
    : ("availability" as const);
}

function inferCurrentAccessScope(
  details: CopilotPackageDetail,
  target: PackageAccessUpdate["target"],
  principals: PackageAccessEntity[],
) {
  const indicator = normalizePackageStatus(
    target === "availability" ? details.availableTo : details.deployedTo,
  );

  if (indicator === "all") {
    return "all" as const;
  }

  if (indicator === "none") {
    return "none" as const;
  }

  if (indicator === "some") {
    return "specific" as const;
  }

  if (target === "availability" ? details.availableTo !== undefined : details.deployedTo !== undefined) return "unknown" as const;
  if (principals.length > 0) {
    return "specific" as const;
  }

  return "unknown" as const;
}

function deduplicateAccessEntities(entities: PackageAccessEntity[], additional: PackageAccessEntity[] = []) {
  if ([entities, additional].some(values => !Array.isArray(values) || values.length > packageAccessCollectionLimit)) {
    throw new AppError(400, "invalid_principals", "Package access requires at most 5000 principals per collection.");
  }
  const unique = new Map<string, PackageAccessEntity>();

  for (const entity of [...entities, ...additional]) {
    if (!isPackageAccessEntity(entity)) {
      throw new AppError(400, "invalid_principal", "Each access principal requires a user/group type and a bounded, control-free opaque ID.");
    }
    const { resourceId, resourceType } = entity;

    const key = `${resourceType.toLowerCase()}:${resourceId}`;
    unique.set(key, { resourceId, resourceType });
    if (unique.size > packageAccessCollectionLimit) {
      throw new AppError(400, "invalid_principals", "Package access requires at most 5000 principals per collection.");
    }
  }

  return [...unique.values()];
}

function validatePackageAccessPayload(payload: Record<string, PackageAccessEntity[]>) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || Object.keys(payload).length !== 2
    || !Object.hasOwn(payload, "allowedUsersAndGroups") || !Object.hasOwn(payload, "acquireUsersAndGroups")) {
    throw new AppError(400, "invalid_access_update", "Package access PATCH requires exactly both documented access collections.");
  }
  const project = (key: "allowedUsersAndGroups" | "acquireUsersAndGroups") => {
    const property = Object.getOwnPropertyDescriptor(payload, key);
    if (!property || !Object.hasOwn(property, "value")) {
      throw new AppError(400, "invalid_access_update", "Package access PATCH requires own data collections.");
    }
    const values: unknown = property.value;
    if (!Array.isArray(values)) throw new AppError(400, "invalid_principals", "Package access requires principal collections.");
    canonicalAccessEntities(values);
    return Array.from({ length: values.length }, (_, index) => {
      const entity: unknown = Object.getOwnPropertyDescriptor(values, index)?.value;
      if (!isPackageAccessEntity(entity)) throw new AppError(400, "invalid_principal", "Package access requires own principal identities.");
      return { resourceId: entity.resourceId, resourceType: entity.resourceType };
    });
  };
  return { allowedUsersAndGroups: project("allowedUsersAndGroups"), acquireUsersAndGroups: project("acquireUsersAndGroups") };
}

export function buildCopilotAgentsListUrl() {
  const url = new URL(`${graphV1}/copilot/admin/catalog/packages`);
  url.searchParams.set("$filter", copilotFilter);
  return url.toString();
}

function assertPackageAuthority(options: Pick<PackageReadOptions, "signal" | "assertCurrent" | "executionDeadlineAt">) {
  options.signal?.throwIfAborted();
  options.assertCurrent?.();
  if (options.executionDeadlineAt !== undefined) {
    if (!Number.isSafeInteger(options.executionDeadlineAt)) throw new AppError(500, "invalid_read_policy", "Package execution requires a finite absolute deadline.");
    if (Date.now() >= options.executionDeadlineAt) throw new DOMException("Package execution deadline expired.", "TimeoutError");
  }
}

class PackageReadBudget {
  private readonly controller = new AbortController();
  private readonly deadline: number;
  private readonly removeListeners: (() => void)[];
  readonly signal = this.controller.signal;
  readonly options: PackageReadOptions;

  constructor(private readonly parent: PackageReadOptions, durationMs: number,
    private readonly now: () => number, private readonly timeoutReason: Error = new DOMException("Package read deadline expired.", "TimeoutError"),
    private readonly parentBudget?: PackageReadBudget) {
    this.deadline = now() + Math.max(0, durationMs);
    const timeout = AbortSignal.timeout(Math.min(2_147_483_647, Math.max(0, Math.ceil(durationMs))));
    this.removeListeners = [timeout, ...parent.signal ? [parent.signal] : []].map(source => {
      const abort = () => this.controller.abort(source === timeout ? timeoutReason : source.reason);
      if (source.aborted) abort();
      else source.addEventListener("abort", abort, { once: true });
      return () => source.removeEventListener("abort", abort);
    });
    this.options = { ...parent, signal: this.signal, assertCurrent: () => this.assertCurrent() };
  }

  assertCurrent() {
    if (this.parentBudget) this.parentBudget.assertCurrent();
    else assertPackageAuthority(this.parent);
    if (this.now() >= this.deadline) this.controller.abort(this.timeoutReason);
    this.signal.throwIfAborted();
  }

  remainingMs() {
    this.assertCurrent();
    return this.deadline - this.now();
  }

  async callback<T>(operation: () => Promise<T>) {
    const phase = new PackageReadBudget(this.options, Math.min(packageReadTimeoutMs, this.remainingMs()), this.now, undefined, this);
    try {
      phase.assertCurrent();
      const result = await waitForReadRetry(operation, 0, phase.signal);
      phase.assertCurrent();
      return result;
    } catch (error) {
      this.assertCurrent();
      if (isTimeoutError(error)) throw new AppError(504, "provider_timeout", "Microsoft package read preparation did not finish within 30 seconds.");
      throw error;
    } finally { phase.dispose(); }
  }

  async wait<T>(wait: (ms: number, signal?: AbortSignal) => Promise<T>, ms: number) {
    this.assertCurrent();
    const resumeAt = this.now() + ms;
    const result = await waitForReadRetry(wait, ms, this.signal);
    this.assertCurrent();
    // An injected or rounded timer may settle early; it cannot authorize physical dispatch.
    while (this.now() < resumeAt) {
      await waitForReadRetry(defaultRetryPolicy.delay, Math.max(1, Math.ceil(resumeAt - this.now())), this.signal);
      this.assertCurrent();
    }
    return result;
  }

  dispose() {
    for (const remove of this.removeListeners) remove();
  }
}

function requirePackageId(id: string) {
  if (!isPackageId(id)) {
    throw new AppError(400, "invalid_package_id", "An exact bounded package identity is required.");
  }
}

function catalogUrl(value: string, continuation: boolean) {
  const invalid = () => new AppError(502, "invalid_provider_link", "Catalog continuation changed the documented endpoint or query.");
  if (value.length > 8192 || /[\u0000-\u0020\u007F\\]/.test(value)
    || /%(?![0-9a-f]{2})/i.test(value)
    || !value.startsWith(`${graphV1}/copilot/admin/catalog/packages?`)) throw invalid();
  const target = URL.parse(value);
  if (!target || target.origin !== "https://graph.microsoft.com" || target.username || target.password || target.hash
    || target.pathname !== "/v1.0/copilot/admin/catalog/packages") throw invalid();
  const keys = [...target.searchParams.keys()];
  if (new Set(keys).size !== keys.length || keys.some(key => key !== "$filter" && key !== "$skiptoken")
    || target.searchParams.get("$filter") !== copilotFilter
    || target.searchParams.has("$skiptoken") !== continuation) throw invalid();
  const token = target.searchParams.get("$skiptoken");
  if (continuation && (!token || /[\u0000-\u001F\u007F\uFFFD]/u.test(token))) throw invalid();
  const canonical = new URL(buildCopilotAgentsListUrl());
  if (token !== null) canonical.searchParams.set("$skiptoken", token);
  return canonical.toString();
}

export async function graphError(response: Response, signal?: AbortSignal) {
  const body = await boundedProviderText(response, 65_536, signal).catch(() => {
    signal?.throwIfAborted();
    return "";
  });
  return graphResponseError(response, body);
}

export function graphResponseError(response: Response, body = "") {
  const message = `Microsoft Graph request failed with status ${response.status}.`;
  let code = "graph_error";
  let providerErrorCode: string | undefined;
  let throttled = response.status === 429;

  if (body) {
    try {
      const graphDetails = parseProviderContractJson(body, {
        root: { fields: ["error", "Message", "message", "StatusCode"], objects: { error: "error" } },
        error: { fields: ["code", "message"] },
      }, 2) as {
        error?: { code?: string; message?: string };
        Message?: string;
        message?: string;
        StatusCode?: number | string;
      };
      const providerMessage =
        graphDetails.error?.message ??
        graphDetails.Message ??
        graphDetails.message ??
        message;
      const providerCode =
        graphDetails.error?.code ?? graphDetails.StatusCode?.toString() ?? code;
      if (response.status === 424 && typeof providerMessage === "string") throttled = providerMessage.toLowerCase().includes("too many requests");
      if (typeof providerCode === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(providerCode) && providerCode !== "graph_error") {
        code = providerCode;
        providerErrorCode = providerCode;
      }
    } catch {
      // Malformed provider bodies must never become public diagnostics.
    }
  }

  const correlationId = [response.headers.get("request-id"), response.headers.get("client-request-id")]
    .find(value => value !== null && /^[A-Za-z0-9-]{1,128}$/.test(value));
  return new AppError(response.status, code, message, {
    httpStatus: response.status,
    ...(providerErrorCode ? { providerErrorCode } : {}),
    ...(correlationId ? { correlationId } : {}),
    ...(throttled ? { throttled: true } : {}),
    retryAfterMs: retryAfterMs(response.headers.get("Retry-After")),
  });
}

function isRetryableGraphError(error: AppError) {
  if (error.status === 401 || error.status === 403) return false;
  if (graphResponseDiagnostics(error)) return isGraphThrottling(error) || [500, 502, 503, 504].includes(error.status);
  return (
    error.code === "provider_network_error" ||
    error.code === "provider_timeout" ||
    isGraphThrottling(error) ||
    error.status === 503 ||
    error.status === 504
  );
}

function isGraphThrottling(error: AppError) {
  return error.status === 429 || error.status === 424 && typeof error.details === "object" && error.details !== null
    && "throttled" in error.details && error.details.throttled === true;
}

const graphDiagnosticCodes = new Map([
  "Authorization_RequestDenied", "AccessDenied", "ErrorAccessDenied", "Forbidden", "NotFound", "ResourceNotFound",
  "TooManyRequests", "UnknownError", "InternalServerError", "ServiceUnavailable", "BadRequest",
  "InvalidAuthenticationToken", "InvalidRequest", "Request_BadRequest",
].map(code => [code.toLowerCase(), code]));
const diagnosticErrorNames = new Set([
  "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError",
  "AggregateError", "AbortError", "TimeoutError",
]);

export function graphResponseDiagnostics(error: unknown) {
  const status = errorTelemetry(error).status;
  if (status === undefined) return undefined;
  const details: unknown = Object.getOwnPropertyDescriptor(error, "details")?.value;
  if (status < 400 || status > 599
    || typeof details !== "object" || details === null || types.isProxy(details)
    || Object.getOwnPropertyDescriptor(details, "httpStatus")?.value !== status) return undefined;
  const providerCode: unknown = Object.getOwnPropertyDescriptor(details, "providerErrorCode")?.value;
  const requestId: unknown = Object.getOwnPropertyDescriptor(details, "correlationId")?.value;
  return {
    status,
    throttled: status === 429 || status === 424 && Object.getOwnPropertyDescriptor(details, "throttled")?.value === true,
    providerCode: typeof providerCode === "string" && providerCode.length <= 128
      ? graphDiagnosticCodes.get(providerCode.toLowerCase()) : undefined,
    requestId: typeof requestId === "string" && !/[\r\n]/.test(requestId)
      && /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(requestId)
      ? requestId : undefined,
  };
}

export function graphErrorTelemetry(error: unknown) {
  const diagnostics = graphResponseDiagnostics(error);
  const classification = errorTelemetry(error, "provider_error");
  const name = errorName(error);
  return {
    ...classification,
    ...(diagnostics ? {
      errorCode: `graph_http_${diagnostics.status}`,
      errorKind: "application",
      reason: diagnostics.providerCode,
      providerRequestId: diagnostics.requestId,
      ...(diagnostics.throttled ? { outcome: "throttled" } : {}),
    } : classification.errorKind !== "application" && classification.status === undefined
      && name !== undefined && diagnosticErrorNames.has(name) ? { reason: name } : {}),
  };
}

function getRetryDelayMs(
  error: AppError,
  attempt: number,
  retryPolicy: RetryPolicy,
  supportedRetryAfterMs = retryPolicy.maxRetryAfterMs,
) {
  const retryAfter = retryAfterFromDetails(error.details);

  if (retryAfter !== undefined) {
    return retryAfter <= supportedRetryAfterMs ? retryAfter : undefined;
  }

  if (isGraphThrottling(error)) {
    return Math.min(retryPolicy.throttleBaseDelayMs * 2 ** (attempt - 1), retryPolicy.maxThrottleDelayMs);
  }
  return Math.min(
    retryPolicy.baseDelayMs * 2 ** (attempt - 1),
    retryPolicy.maxDelayMs,
  );
}

function retryAfterFromDetails(details: unknown) {
  if (typeof details === "object" && details && "retryAfterMs" in details) {
    const retryAfter = (details as { retryAfterMs?: unknown }).retryAfterMs;
    return typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : undefined;
  }

  return undefined;
}

export function retryAfterMs(value: string | null) {
  if (!value) {
    return undefined;
  }

  if (/^\d+$/.test(value.trim())) {
    const milliseconds = Number(value) * 1000;
    // A valid but unrepresentable cooldown must fail closed, never become fallback backoff.
    return Number.isSafeInteger(milliseconds) ? milliseconds : Number.MAX_SAFE_INTEGER;
  }

  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value.trim())) return undefined;
  const date = Date.parse(value);

  if (!Number.isNaN(date) && new Date(date).toUTCString() === value.trim()) {
    return Math.max(0, date - Date.now());
  }

  return undefined;
}

async function waitForReadRetry<T>(wait: (delayMs: number, signal?: AbortSignal) => Promise<T>, delayMs: number, signal?: AbortSignal): Promise<T> {
  const deadline = signal ?? AbortSignal.timeout(delayMs + packageReadTimeoutMs);
  deadline.throwIfAborted();
  let removeAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(deadline.reason);
    deadline.addEventListener("abort", onAbort, { once: true });
    removeAbort = () => deadline.removeEventListener("abort", onAbort);
  });
  try {
    const result = await Promise.race([signal ? wait(delayMs, signal) : wait(delayMs), aborted]);
    deadline.throwIfAborted();
    return result;
  } catch (error) {
    deadline.throwIfAborted();
    throw error;
  } finally {
    removeAbort();
  }
}
