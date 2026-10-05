import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { parse } from "csv-parse";
import { AppError } from "../errors.js";
import { dataLimitError, encodeBatch } from "../db/dataBounds.js";
import type { ActivityRecord, BeginGeneration, GenerationLease } from "../db/dataGenerations.js";
import { UserSourceStages, type UserSourceCompletion } from "../db/userSourceStages.js";
import type { UserSourceKind } from "../types/userSources.js";
import { graphError, retryAfterMs, type FetchLike } from "./graphPackages.js";
import { operationalLog } from "./telemetry.js";
import { boundedProviderJson, ProviderResponseLimitError } from "./providerJson.js";
import {
  buildCopilotReportUrl, buildCopilotUsersUrl, buildReportedUsersUrl, buildSubscribedSkusUrl,
  parseDirectoryUser, parseReportUser, parseSubscribedSku, reportHeaders, validateGraphUrl, validateReportDownloadUrl,
  type DirectoryFilter,
} from "./userSourceGraphFields.js";
import { activitySourceRecord } from "./userSourceRecords.js";
import type { CopilotDirectoryUser } from "../types/copilotUsage.js";
import type { UserSourcesRepository } from "../db/userSources.js";
import type { SelectionIdentity } from "./dataSelections.js";

type Collection = { value?: unknown[]; "@odata.count"?: unknown; "@odata.nextLink"?: unknown };
export type UserSourceAuthorization = (source: UserSourceKind, signal: AbortSignal) => Promise<string>;

export class UserSourceProvider {
  constructor(private readonly fetcher: FetchLike = fetch,
    private readonly wait: (ms: number, signal: AbortSignal) => Promise<unknown> = (ms, signal) => delay(ms, undefined, { signal })) {}

  refresh(stages: UserSourceStages, input: BeginGeneration, options: {
    authorize: UserSourceAuthorization; completeJob?: UserSourceCompletion; signal?: AbortSignal;
    identities?: (lease: GenerationLease, signal: AbortSignal) => Promise<void>;
    progress?: (count: number) => Promise<void>;
  }) {
    const source = input.scope.source as UserSourceKind;
    return stages.execute(input, async (lease, signal) => {
      const token = await options.authorize(source, signal);
      signal.throwIfAborted();
      if (source === "directory") {
        await options.identities?.(lease, signal);
        await this.directory(stages, lease, token, signal, options.progress);
      } else {
        await this.activity(stages, lease, token, signal);
      }
    }, { signal: options.signal, completeJob: options.completeJob, beforePublish: async signal => {
      await options.authorize(source, signal);
    } });
  }

  async refreshSources(stages: UserSourceStages, repository: UserSourcesRepository, identity: SelectionIdentity,
    inputs: readonly BeginGeneration[], options: Parameters<UserSourceProvider["refresh"]>[2]) {
    if (!inputs.length || inputs.length > 2 || new Set(inputs.map(input => input.scope.source)).size !== inputs.length
      || inputs.some(input => input.scope.tenantId !== identity.tenantId || input.scope.principalId !== identity.principalId
        || input.sessionEpoch !== identity.sessionEpoch || input.scope.tokenMode !== inputs[0].scope.tokenMode)) throw new Error("user_source_refresh_scope");
    const outcomes = await Promise.allSettled(inputs.map(input => this.refresh(stages, input, options)));
    options.signal?.throwIfAborted();
    const summary = await repository.refreshStatus(identity, inputs[0].scope.tokenMode as "delegated" | "application");
    return { ...summary, status: summary.status === "succeeded" && outcomes.some(outcome => outcome.status === "rejected") ? "partial" as const : summary.status,
      outcomes: outcomes.map((outcome, index) => ({ source: inputs[index].scope.source,
        status: outcome.status, ...(outcome.status === "rejected" ? {
          errorCode: outcome.reason instanceof AppError ? outcome.reason.code : "user_source_failed",
        } : {}) })) };
  }

  async directory(stages: UserSourceStages, lease: GenerationLease, token: string, signal: AbortSignal,
    progress?: (count: number) => Promise<void>) {
    const catalogKey = await stages.query(lease, "catalog", buildSubscribedSkusUrl());
    let url: string | undefined = buildSubscribedSkusUrl();
    let catalogWire = 0;
    while (url) {
      signal.throwIfAborted();
      await stages.assertNewPage(lease, catalogKey, url);
      const page = await this.collection(url, token, "catalog", signal);
      catalogWire += page.value!.length;
      if (catalogWire > 1000) throw dataLimitError("provider_sku_limit", 1000, catalogWire);
      await stages.page(lease, catalogKey, url, page.value!.length, count(page));
      for (let offset = 0; offset < page.value!.length; offset += 250) {
        await stages.skus(lease, catalogKey, page.value!.slice(offset, offset + 250).map(parseSubscribedSku));
      }
      url = continuation(page, "catalog");
    }
    await stages.finishQuery(lease, catalogKey);
    let lastSku = "";
    for (;;) {
      const batch = await stages.skuBatch(lease, lastSku);
      if (!batch.length) break;
      const ids = batch.map(row => row.skuId);
      await this.users(stages, lease, buildCopilotUsersUrl(ids), { kind: "products", skuIds: ids }, token, signal, progress);
      lastSku = batch.at(-1)!.skuId;
    }
    for (;;) {
      const identities = await stages.verificationBatch(lease);
      if (!identities.length) break;
      let initialUrl = buildReportedUsersUrl(identities);
      while (initialUrl.length > 8192 && identities.length > 1) {
        identities.pop();
        initialUrl = buildReportedUsersUrl(identities);
      }
      if (initialUrl.length > 8192) throw new AppError(502, "invalid_provider_link", "Exact query URL exceeds its bound.");
      await this.users(stages, lease, initialUrl, { kind: "reported", identities }, token, signal, progress);
      await stages.verified(lease, identities);
    }
    const observed = await stages.progress(lease);
    await progress?.(observed);
  }

  private async users(stages: UserSourceStages, lease: GenerationLease, initialUrl: string, filter: DirectoryFilter,
    token: string, signal: AbortSignal, progress?: (count: number) => Promise<void>) {
    const key = await stages.query(lease, filter.kind === "products" ? "discovery" : "identity", initialUrl);
    let url: string | undefined = initialUrl;
    while (url) {
      signal.throwIfAborted();
      await stages.assertNewPage(lease, key, url);
      const page = await this.collection(url, token, "directory", signal);
      if (page.value!.length > 100) throw dataLimitError("provider_page_rows", 100, page.value!.length);
      const total = count(page);
      if (filter.kind === "reported" && total !== undefined && total > filter.identities.length) {
        throw new AppError(502, "provider_count_mismatch", "Exact identity count exceeds its requested batch.");
      }
      await stages.page(lease, key, url, page.value!.length, total);
      let batch: CopilotDirectoryUser[] = [];
      for (const value of page.value!) {
        signal.throwIfAborted();
        const licenses = (value as { assignedLicenses?: unknown })?.assignedLicenses;
        if (!Array.isArray(licenses) || licenses.length > 1000) throw new AppError(502, "provider_schema", "Invalid license assignments.");
        const ids = licenses.map(item => {
          if (!item || typeof item.skuId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(item.skuId)) {
            throw new AppError(502, "provider_schema", "Invalid SKU identity.");
          }
          return item.skuId.toLowerCase();
        });
        const user = parseDirectoryUser(value, await stages.skuEvidence(lease, ids), filter);
        if (!user) throw new AppError(502, "provider_schema", "Directory returned an identity outside the requested filter.");
        try { encodeBatch([...batch, user], [lease.id, lease.scopeId, lease.tenantId]); }
        catch (error) {
          if (!(error instanceof AppError) || error.code !== "data_batch_bytes" || !batch.length) throw error;
          await stages.directory(lease, key, batch);
          batch = [];
        }
        batch.push(user);
      }
      if (batch.length) await stages.directory(lease, key, batch);
      const observed = await stages.progress(lease);
      await progress?.(observed);
      url = continuation(page, "directory");
      if (url) {
        const filters = new URL(url).searchParams.getAll("$filter");
        if (filters.length !== 1 || filters[0] !== new URL(initialUrl).searchParams.get("$filter")) {
          throw new AppError(502, "provider_schema", "Continuation changed its directory filter.");
        }
      }
    }
    await stages.finishQuery(lease, key);
    await stages.progress(lease);
  }

  async activity(stages: UserSourceStages, lease: GenerationLease, token: string, signal: AbortSignal) {
    const url = buildCopilotReportUrl();
    const key = await stages.query(lease, "activity", url);
    const { response, requestSignal } = await this.reportResponse(url, token, signal);
    let ordinal = 0;
    let batchOrdinal = 0;
    let batch: ActivityRecord[] = [];
    for await (const row of streamAppActivity(response, requestSignal)) {
      batch.push(activitySourceRecord(row, ++ordinal));
      if (batch.length === 250) {
        requestSignal.throwIfAborted();
        await stages.page(lease, key, `${url}#batch=${batchOrdinal++}`, batch.length);
        requestSignal.throwIfAborted();
        await stages.activity(lease, key, batch);
        batch = [];
      }
    }
    requestSignal.throwIfAborted();
    if (batch.length || ordinal === 0) {
      await stages.page(lease, key, `${url}#batch=${batchOrdinal}`, batch.length);
      requestSignal.throwIfAborted();
      if (batch.length) await stages.activity(lease, key, batch);
    }
    requestSignal.throwIfAborted();
    await stages.finishQuery(lease, key);
    requestSignal.throwIfAborted();
    await stages.progress(lease);
  }

  private async collection(url: string, token: string, kind: "catalog" | "directory", signal: AbortSignal) {
    validateUrl(url, kind);
    const { response, requestSignal } = await this.request(url, token, signal, false, kind === "directory");
    try {
      const page = await boundedProviderJson<Collection>(response, requestSignal, kind === "directory" ? 16 * 1024 ** 2 : 2_000_000);
      if (!page || !Array.isArray(page.value)) throw new AppError(502, "provider_schema", "Invalid Graph collection.");
      return page;
    } catch (error) {
      if (error instanceof ProviderResponseLimitError) throw new AppError(502, "provider_response_size_limit", "Graph page exceeds its byte limit.");
      throw error;
    }
  }

  private async request(url: string, token: string | null, signal: AbortSignal, report: boolean, directory = false) {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const headerDeadline = new AbortController();
      const timer = report ? setTimeout(() => headerDeadline.abort(new DOMException("Report headers exceeded 15 seconds.","TimeoutError")),15_000) : undefined;
      timer?.unref();
      const requestSignal = AbortSignal.any([signal,report ? headerDeadline.signal : AbortSignal.timeout(15_000)]);
      try {
      const response = await this.fetcher(url, {
        method: "GET", redirect: report ? "manual" : "error", signal: requestSignal,
        headers: { ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
          Accept: report ? "text/csv, application/octet-stream" : "application/json",
          ...(directory ? { ConsistencyLevel: "eventual" } : {}) },
      });
      if (response.ok || report && response.status === 302) return { response, requestSignal };
      if (report && response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => {});
        throw new AppError(502, "invalid_provider_link", "Unsupported report redirect.");
      }
      if (token === null) return { response, requestSignal };
      const error = await graphError(response, requestSignal);
      const details = error.details as { retryAfterMs?: number };
      const wait = details.retryAfterMs ?? Math.min(30_000, 2000 * 2 ** attempt);
      if (attempt >= 2 || ![429, 500, 502, 503, 504].includes(response.status) || wait > 600_000) throw error;
      await this.wait(wait, signal);
      signal.throwIfAborted();
      } finally { clearTimeout(timer); }
    }
  }

  private async reportResponse(url: string, token: string, signal: AbortSignal) {
    validateUrl(url, "report");
    for (let attempt = 0; ; attempt++) {
      const first = await this.request(url, token, signal, true);
      if (first.response.status !== 302) return first;
      void first.response.body?.cancel().catch(() => {});
      const download = validateReportDownloadUrl(first.response.headers.get("location"));
      const next = await this.request(download, null, signal, true);
      if (next.response.status === 302) {
        void next.response.body?.cancel().catch(() => {});
        throw new AppError(502, "invalid_provider_link", "Repeated report redirect.");
      }
      if (next.response.ok) return next;
      const status = next.response.status;
      const wait = retryAfterMs(next.response.headers.get("Retry-After")) ?? Math.min(30_000, 2000 * 2 ** attempt);
      void next.response.body?.cancel().catch(() => {});
      if (attempt >= 2 || ![401, 403, 404, 410, 429, 500, 502, 503, 504].includes(status) || wait > 600_000) {
        operationalLog("warn", "report_download_failed", { provider: "graph", source: "app_activity", status, attempt: attempt + 1 });
        throw new AppError(502, "report_download_failed",
          `Microsoft report download returned HTTP ${status}; retry Sync to request a fresh download.`, { httpStatus: status });
      }
      operationalLog("warn", "report_download_retry", {
        provider: "graph", source: "app_activity", status, attempt: attempt + 1, retryDelayMs: wait,
      });
      await this.wait(wait, signal);
      signal.throwIfAborted();
    }
  }
}

export async function* streamAppActivity(response: Response, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!response.body) throw new AppError(502, "provider_schema", "Empty activity response.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  async function* text() {
    try {
      for (;;) {
        signal.throwIfAborted();
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
        signal.throwIfAborted();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 64 * 1024 ** 2) throw dataLimitError("provider_report_bytes", 64 * 1024 ** 2, bytes);
        for (let offset = 0; offset < chunk.value.byteLength; offset += 16 * 1024) {
          yield decoder.decode(chunk.value.subarray(offset, offset + 16 * 1024), { stream: true });
        }
      }
      yield decoder.decode();
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  signal.throwIfAborted();
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
      signal.throwIfAborted();
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
    if (!columns) throw new AppError(502, "provider_schema", "Empty activity CSV.");
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof AppError) throw error;
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
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw new AppError(502, "invalid_provider_link", "Invalid continuation.");
  validateUrl(value, kind);
  return value;
}
