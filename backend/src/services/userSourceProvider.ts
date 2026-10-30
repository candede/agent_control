import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { parse } from "csv-parse";
import { AppError, errorTelemetry, hasNativeErrorPrototype, isApplicationError } from "../errors.js";
import { dataLimitError, encodeBatch } from "../db/dataBounds.js";
import type { ActivityRecord, BeginGeneration, GenerationLease } from "../db/dataGenerations.js";
import { UserSourceStages, type UserSourceCompletion } from "../db/userSourceStages.js";
import type { UserSourceKind } from "../types/userSources.js";
import { graphError, graphResponseError, retryAfterMs, type FetchLike } from "./graphPackages.js";
import { operationalLog } from "./telemetry.js";
import { boundedProviderJson, parseProviderContractJson, ProviderResponseLimitError } from "./providerJson.js";
import {
  buildCopilotReportUrl, buildCopilotUsersUrl, buildReportedUsersUrl, buildSubscribedSkusUrl,
  parseDirectoryUser, parseReportUser, parseSubscribedSku, reportHeaders, validateGraphUrl, validateReportDownloadUrl,
  type DirectoryFilter,
} from "./userSourceGraphFields.js";
import { activitySourceRecord } from "./userSourceRecords.js";
import { isGraphGuid, type CopilotDirectoryUser } from "../types/copilotUsage.js";
import type { UserSourcesRepository } from "../db/userSources.js";
import type { SelectionIdentity } from "./dataSelections.js";

type Collection = { value?: unknown[]; "@odata.count"?: unknown; "@odata.nextLink"?: unknown };
export type UserSourceAuthorization = (source: UserSourceKind, signal: AbortSignal) => Promise<string>;

export class UserSourceProvider {
  constructor(private readonly fetcher: FetchLike = fetch,
    private readonly wait: (ms: number, signal: AbortSignal) => Promise<unknown> = (ms, signal) => delay(ms, undefined, { signal })) {}

  refresh(stages: UserSourceStages, input: BeginGeneration, options: {
    authorize: UserSourceAuthorization; completeJob?: UserSourceCompletion; signal?: AbortSignal;
    assertCurrent?: () => void;
    identities?: (lease: GenerationLease, signal: AbortSignal) => Promise<void>;
    progress?: (count: number) => Promise<void>;
  }) {
    const source = input.scope.source as UserSourceKind;
    return stages.execute(input, async (lease, signal) => {
      const fence = () => { signal.throwIfAborted(); options.assertCurrent?.(); };
      fence();
      const token = await options.authorize(source, signal);
      fence();
      if (source === "directory") {
        await options.identities?.(lease, signal);
        fence();
        await this.directory(stages, lease, token, signal, options.progress, fence);
      } else {
        await this.activity(stages, lease, token, signal, fence);
      }
      fence();
    }, { signal: options.signal, completeJob: options.completeJob, beforeCommit: options.assertCurrent, beforePublish: async signal => {
      signal.throwIfAborted(); options.assertCurrent?.();
      await options.authorize(source, signal);
      signal.throwIfAborted(); options.assertCurrent?.();
    } });
  }

  async refreshSources(stages: UserSourceStages, repository: UserSourcesRepository, identity: SelectionIdentity,
    inputs: readonly BeginGeneration[], options: Parameters<UserSourceProvider["refresh"]>[2]) {
    const fence = () => { options.signal?.throwIfAborted(); options.assertCurrent?.(); };
    fence();
    if (!inputs.length || inputs.length > 2 || new Set(inputs.map(input => input.scope.source)).size !== inputs.length
      || inputs.some(input => input.scope.tenantId !== identity.tenantId || input.actorPrincipalId !== identity.principalId
        || input.sessionEpoch !== identity.sessionEpoch || input.scope.kind !== "tenant" || input.scope.tokenMode !== "tenant")) throw new Error("user_source_refresh_scope");
    const outcomes = await Promise.allSettled(inputs.map(input => this.refresh(stages, input, options)));
    fence();
    const summary = await repository.refreshStatus(identity);
    fence();
    return { ...summary, status: summary.status === "succeeded" && outcomes.some(outcome => outcome.status === "rejected") ? "partial" as const : summary.status,
      outcomes: outcomes.map((outcome, index) => ({ source: inputs[index].scope.source,
        status: outcome.status, ...(outcome.status === "rejected" ? {
          errorCode: errorTelemetry(outcome.reason, "user_source_failed").errorCode,
        } : {}) })) };
  }

  async directory(stages: UserSourceStages, lease: GenerationLease, token: string, signal: AbortSignal,
    progress?: (count: number) => Promise<void>, assertCurrent?: () => void) {
    const fence = () => { signal.throwIfAborted(); assertCurrent?.(); };
    fence();
    const catalogKey = await stages.query(lease, "catalog", buildSubscribedSkusUrl());
    fence();
    let url: string | undefined = buildSubscribedSkusUrl();
    let catalogWire = 0;
    while (url) {
      fence();
      await stages.assertNewPage(lease, catalogKey, url);
      fence();
      const page = await this.collection(url, token, "catalog", signal, fence);
      fence();
      catalogWire += page.value!.length;
      if (catalogWire > 1000) throw dataLimitError("provider_sku_limit", 1000, catalogWire);
      await stages.page(lease, catalogKey, url, page.value!.length, count(page));
      fence();
      for (let offset = 0; offset < page.value!.length; offset += 250) {
        await stages.skus(lease, catalogKey, page.value!.slice(offset, offset + 250).map(parseSubscribedSku));
        fence();
      }
      url = continuation(page, "catalog");
    }
    await stages.finishQuery(lease, catalogKey);
    fence();
    let lastSku = "";
    for (;;) {
      const batch = await stages.skuBatch(lease, lastSku);
      fence();
      if (!batch.length) break;
      const ids = batch.map(row => row.skuId);
      await this.users(stages, lease, buildCopilotUsersUrl(ids), { kind: "products", skuIds: ids }, token, signal, progress, fence);
      fence();
      lastSku = batch.at(-1)!.skuId;
    }
    for (;;) {
      const identities = await stages.verificationBatch(lease);
      fence();
      if (!identities.length) break;
      let initialUrl = buildReportedUsersUrl(identities);
      while (initialUrl.length > 8192 && identities.length > 1) {
        identities.pop();
        initialUrl = buildReportedUsersUrl(identities);
      }
      if (initialUrl.length > 8192) throw new AppError(502, "invalid_provider_link", "Exact query URL exceeds its bound.");
      await this.users(stages, lease, initialUrl, { kind: "reported", identities }, token, signal, progress, fence);
      fence();
      await stages.verified(lease, identities);
      fence();
    }
    const observed = await stages.progress(lease);
    fence();
    await progress?.(observed);
    fence();
  }

  private async users(stages: UserSourceStages, lease: GenerationLease, initialUrl: string, filter: DirectoryFilter,
    token: string, signal: AbortSignal, progress: ((count: number) => Promise<void>) | undefined, assertCurrent: () => void) {
    assertCurrent();
    const key = await stages.query(lease, filter.kind === "products" ? "discovery" : "identity", initialUrl);
    assertCurrent();
    let url: string | undefined = initialUrl;
    while (url) {
      assertCurrent();
      await stages.assertNewPage(lease, key, url);
      assertCurrent();
      const page = await this.collection(url, token, "directory", signal, assertCurrent);
      assertCurrent();
      if (page.value!.length > 100) throw dataLimitError("provider_page_rows", 100, page.value!.length);
      const total = count(page);
      if (filter.kind === "reported" && total !== undefined && total > filter.identities.length) {
        throw new AppError(502, "provider_count_mismatch", "Exact identity count exceeds its requested batch.");
      }
      await stages.page(lease, key, url, page.value!.length, total);
      assertCurrent();
      let batch: CopilotDirectoryUser[] = [];
      for (const value of page.value!) {
        assertCurrent();
        const licenses = (value as { assignedLicenses?: unknown })?.assignedLicenses;
        if (!Array.isArray(licenses) || licenses.length > 1000) throw new AppError(502, "provider_schema", "Invalid license assignments.");
        const ids = licenses.map(item => {
          if (!item || !isGraphGuid(item.skuId)) {
            throw new AppError(502, "provider_schema", "Invalid SKU identity.");
          }
          return item.skuId.toLowerCase();
        });
        const evidence = await stages.skuEvidence(lease, ids);
        assertCurrent();
        const user = parseDirectoryUser(value, evidence, filter);
        if (!user) throw new AppError(502, "provider_schema", "Directory returned an identity outside the requested filter.");
        try { encodeBatch([...batch, user], [lease.id, lease.scopeId, lease.tenantId]); }
        catch (error) {
          if (!isApplicationError(error) || Object.getOwnPropertyDescriptor(error, "code")?.value !== "data_batch_bytes" || !batch.length) throw error;
          await stages.directory(lease, key, batch);
          assertCurrent();
          batch = [];
        }
        batch.push(user);
      }
      if (batch.length) await stages.directory(lease, key, batch);
      assertCurrent();
      const observed = await stages.progress(lease);
      assertCurrent();
      await progress?.(observed);
      assertCurrent();
      url = continuation(page, "directory");
      if (url) {
        const filters = new URL(url).searchParams.getAll("$filter");
        if (filters.length !== 1 || filters[0] !== new URL(initialUrl).searchParams.get("$filter")) {
          throw new AppError(502, "provider_schema", "Continuation changed its directory filter.");
        }
      }
    }
    await stages.finishQuery(lease, key);
    assertCurrent();
    await stages.progress(lease);
    assertCurrent();
  }

  async activity(stages: UserSourceStages, lease: GenerationLease, token: string, signal: AbortSignal, assertCurrent?: () => void) {
    const fence = () => { signal.throwIfAborted(); assertCurrent?.(); };
    fence();
    const url = buildCopilotReportUrl();
    const key = await stages.query(lease, "activity", url);
    fence();
    const { response, requestSignal } = await this.reportResponse(url, token, signal, fence);
    let ordinal = 0;
    let batchOrdinal = 0;
    let batch: ActivityRecord[] = [];
    for await (const row of streamAppActivity(response, requestSignal, fence)) {
      batch.push(activitySourceRecord(row, ++ordinal));
      if (batch.length === 250) {
        requestSignal.throwIfAborted();
        await stages.page(lease, key, `${url}#batch=${batchOrdinal++}`, batch.length);
        requestSignal.throwIfAborted();
        fence();
        await stages.activity(lease, key, batch);
        fence();
        batch = [];
      }
    }
    requestSignal.throwIfAborted();
    fence();
    if (batch.length || ordinal === 0) {
      await stages.page(lease, key, `${url}#batch=${batchOrdinal}`, batch.length);
      requestSignal.throwIfAborted();
      fence();
      if (batch.length) await stages.activity(lease, key, batch);
      fence();
    }
    requestSignal.throwIfAborted();
    await stages.finishQuery(lease, key);
    requestSignal.throwIfAborted();
    fence();
    await stages.progress(lease);
    fence();
  }

  private async collection(url: string, token: string, kind: "catalog" | "directory", signal: AbortSignal, assertCurrent: () => void) {
    validateUrl(url, kind);
    const { response, requestSignal } = await this.request(url, token, signal, false, kind === "directory", assertCurrent);
    try {
      const page = await boundedProviderJson<Collection>(response, requestSignal, kind === "directory" ? 16 * 1024 ** 2 : 2_000_000,
        text => parseUserSourceJson(text, kind));
      assertCurrent();
      if (!page || !Array.isArray(page.value)) throw new AppError(502, "provider_schema", "Invalid Graph collection.");
      return page;
    } catch (error) {
      assertCurrent();
      if (requestSignal.aborted) throw new AppError(504, "provider_timeout", "Graph page exceeded its 15-second deadline.");
      if (hasNativeErrorPrototype(error, ProviderResponseLimitError.prototype)) throw new AppError(502, "provider_response_size_limit", "Graph page exceeds its byte limit.");
      throw error;
    }
  }

  private async request(url: string, token: string | null, signal: AbortSignal, report: boolean, directory: boolean, assertCurrent: () => void) {
    for (let attempt = 0; ; attempt++) {
      assertCurrent();
      const headerDeadline = new AbortController();
      const timer = report ? setTimeout(() => headerDeadline.abort(new DOMException("Report headers exceeded 15 seconds.","TimeoutError")),15_000) : undefined;
      timer?.unref();
      const requestSignal = AbortSignal.any([signal,report ? headerDeadline.signal : AbortSignal.timeout(15_000)]);
      let removeAbort = () => {};
      try {
      const fetching = this.fetcher(url, {
        method: "GET", redirect: report ? "manual" : "error", signal: requestSignal,
        headers: { ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
          Accept: report ? "text/csv, application/octet-stream" : "application/json",
          ...(directory ? { ConsistencyLevel: "eventual" } : {}) },
      });
      const aborted = new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(requestSignal.reason);
        if (requestSignal.aborted) onAbort();
        else requestSignal.addEventListener("abort", onAbort, { once: true });
        removeAbort = () => requestSignal.removeEventListener("abort", onAbort);
      });
      // A transport may ignore abort; do not retain any response it delivers after expiry.
      void fetching.then(response => {
        if (requestSignal.aborted) void response.body?.cancel().catch(() => {});
      }, () => {});
      const response = await Promise.race([fetching, aborted]);
      try { assertCurrent(); requestSignal.throwIfAborted(); }
      catch (error) {
        void response.body?.cancel().catch(() => {});
        throw error;
      }
      if (response.ok || report && response.status === 302) return { response, requestSignal };
      if (report && response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => {});
        throw new AppError(502, "invalid_provider_link", "Unsupported report redirect.");
      }
      if (token === null) return { response, requestSignal };
      let error: AppError;
      try { error = await graphError(response, requestSignal); }
      catch (failure) {
        signal.throwIfAborted();
        if (!requestSignal.aborted) throw failure;
        // A slow error body cannot erase an already received denial or cooldown.
        error = graphResponseError(response);
      }
      assertCurrent();
      const details = error.details as { retryAfterMs?: number };
      const wait = details.retryAfterMs ?? Math.min(30_000, 2000 * 2 ** attempt);
      if (attempt >= 2 || ![429, 500, 502, 503, 504].includes(response.status) || wait > 600_000) throw error;
      await this.wait(wait, signal);
      assertCurrent();
      } catch (error) {
        assertCurrent();
        if (requestSignal.aborted && !isApplicationError(error)) {
          throw new AppError(504, "provider_timeout", "Provider request exceeded its 15-second deadline.");
        }
        throw error;
      } finally { removeAbort(); clearTimeout(timer); }
    }
  }

  private async reportResponse(url: string, token: string, signal: AbortSignal, assertCurrent: () => void) {
    validateUrl(url, "report");
    for (let attempt = 0; ; attempt++) {
      const first = await this.request(url, token, signal, true, false, assertCurrent);
      if (first.response.status !== 302) return first;
      void first.response.body?.cancel().catch(() => {});
      const download = validateReportDownloadUrl(first.response.headers.get("location"));
      const next = await this.request(download, null, signal, true, false, assertCurrent);
      if (next.response.status === 302) {
        void next.response.body?.cancel().catch(() => {});
        throw new AppError(502, "invalid_provider_link", "Repeated report redirect.");
      }
      if (next.response.ok) return next;
      const status = next.response.status;
      const retryDelay = retryAfterMs(next.response.headers.get("Retry-After"));
      const wait = retryDelay ?? Math.min(30_000, 2000 * 2 ** attempt);
      void next.response.body?.cancel().catch(() => {});
      if (attempt >= 2 || ![401, 403, 404, 410, 429, 500, 502, 503, 504].includes(status) || wait > 600_000) {
        operationalLog("warn", "report_download_failed", { provider: "graph", source: "app_activity", status, attempt: attempt + 1 });
        throw new AppError(502, "report_download_failed",
          `Microsoft report download returned HTTP ${status}; retry Sync to request a fresh download.`,
          { httpStatus: status, ...(retryDelay !== undefined ? { retryAfterMs: retryDelay } : {}) });
      }
      operationalLog("warn", "report_download_retry", {
        provider: "graph", source: "app_activity", status, attempt: attempt + 1, retryDelayMs: wait,
      });
      await this.wait(wait, signal);
      assertCurrent();
    }
  }
}

function parseUserSourceJson(text: string, kind: "catalog" | "directory"): unknown {
  return parseProviderContractJson(text, {
    root: { fields: ["value", "@odata.count", "@odata.nextLink"], arrays: { value: kind } },
    catalog: { fields: ["skuId", "appliesTo", "servicePlans"], arrays: { servicePlans: "skuPlan" } },
    skuPlan: { fields: ["servicePlanId"] },
    directory: {
      fields: ["id", "userPrincipalName", "displayName", "accountEnabled", "employeeType", "companyName", "department",
        "userType", "assignedLicenses", "assignedPlans"],
      arrays: { assignedLicenses: "license", assignedPlans: "assignedPlan" },
    },
    license: { fields: ["skuId", "disabledPlans"] },
    assignedPlan: { fields: ["servicePlanId", "service", "capabilityStatus", "assignedDateTime"] },
  }, 5);
}

export async function* streamAppActivity(response: Response, signal: AbortSignal, assertCurrent?: () => void) {
  let cancelBody = (reason: unknown) => { void response.body?.cancel(reason).catch(() => {}); };
  const fence = () => {
    try { signal.throwIfAborted(); assertCurrent?.(); }
    catch (error) { cancelBody(error); throw error; }
  };
  fence();
  if (!response.body) throw new AppError(502, "provider_schema", "Empty activity response.");
  const reader = response.body.getReader();
  cancelBody = reason => { void reader.cancel(reason).catch(() => {}); };
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let bodyFailure: unknown;
  const abort = () => cancelBody(signal.reason);
  async function* text() {
    try {
      for (;;) {
        fence();
        let timer: NodeJS.Timeout | undefined;
        const pending = reader.read();
        const deadline = new Promise<never>((_resolve,reject) => {
          timer = setTimeout(() => {
            const error = new AppError(504,"provider_timeout","Activity report body made no progress for 15 seconds.");
            reject(error);
            void reader.cancel(error).catch(() => {});
          },15_000);
          timer.unref();
        });
        // Database backpressure is covered by the source deadline and lease,
        // not an HTTP-body timer running while no network read is pending.
        const chunk = await Promise.race([pending,deadline]).finally(() => clearTimeout(timer));
        fence();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 64 * 1024 ** 2) throw dataLimitError("provider_report_bytes", 64 * 1024 ** 2, bytes);
        const owned = Buffer.from(chunk.value);
        for (let offset = 0; offset < owned.byteLength; offset += 16 * 1024) {
          yield decoder.decode(owned.subarray(offset, offset + 16 * 1024), { stream: true });
        }
      }
      yield decoder.decode();
    } catch (error) {
      bodyFailure = error;
      // Node streams inspect error.message; never hand them a borrowed error or accessor.
      throw new AppError(502, "provider_schema", "Invalid activity CSV or UTF-8.");
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  fence();
  signal.addEventListener("abort", abort, { once: true });
  const input = Readable.from(text(), { highWaterMark: 1 });
  let parsedRecords = 0;
  const parserOptions = { bom: true, skip_empty_lines: true, relax_column_count: false, max_record_size: 64 * 1024,
    on_record: (record: string[]) => {
      if (++parsedRecords>100_001) throw dataLimitError("provider_report_rows",100_000,parsedRecords-1);
      return record;
    },
    readableHighWaterMark: 1, writableHighWaterMark: 16 * 1024 };
  const parser = parse(parserOptions);
  input.on("error", error => parser.destroy(error));
  input.pipe(parser);
  let columns: number[] | undefined;
  let rows = 0;
  try {
    for await (const value of parser) {
      fence();
      const row = value as string[];
      if (!columns) {
        columns = reportHeaders.map(header => row.indexOf(header));
        if (new Set(row).size !== row.length || row.some(header => !header.trim() || header.length > 1024)
          || columns.some(index => index < 0)) throw new AppError(502, "provider_schema", "Unsupported activity CSV headers.");
        continue;
      }
      if (++rows > 100_000) throw dataLimitError("provider_report_rows", 100_000, rows);
      yield parseReportUser(columns.map(index => row[index]));
    }
    fence();
    if (!columns) throw new AppError(502, "provider_schema", "Empty activity CSV.");
  } catch (error) {
    fence();
    if (isApplicationError(bodyFailure)) throw bodyFailure;
    if (isApplicationError(error)) throw error;
    throw new AppError(502, "provider_schema", "Invalid activity CSV or UTF-8.");
  } finally {
    signal.removeEventListener("abort", abort);
    parser.destroy();
    input.destroy();
    void reader.cancel().catch(() => {});
  }
}

function count(page: Collection) {
  const value = page["@odata.count"];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new AppError(502, "provider_count_mismatch", "Invalid Graph count.");
  return value as number;
}
function validateUrl(url: string, kind: "directory" | "catalog" | "report") {
  validateGraphUrl(url, kind);
  if (url.length > 8192 || new URL(url).hash) throw new AppError(502, "invalid_provider_link", "Invalid Graph URL.");
}
function continuation(page: Collection, kind: "directory" | "catalog") {
  const value = page["@odata.nextLink"];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new AppError(502, "invalid_provider_link", "Invalid continuation.");
  validateUrl(value, kind);
  return value;
}
