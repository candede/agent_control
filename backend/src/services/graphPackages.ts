import { AppError } from "../errors.js";
import { setTimeout as delay } from "node:timers/promises";
import type {
  BulkActionResult,
  BulkPackageDetailResult,
  BulkPackageDetailsResult,
  BulkPackageResult,
  CopilotPackage,
  CopilotPackageDetail,
  GraphCollectionResponse,
} from "../types/copilotPackage.js";

const graphV1 = "https://graph.microsoft.com/v1.0";
const graphBeta = "https://graph.microsoft.com/beta";
const copilotFilter = "supportedHosts/any(h:h eq 'Copilot')";
const bulkDetailConcurrency = 6;
const bulkWriteConcurrency = 4;
const bulkWritePauseMs = 250;
const defaultRetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 2_000,
  maxDelayMs: 30_000,
  delay,
};

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

type RetryPolicy = typeof defaultRetryPolicy;

type BulkSetBlockedStateOptions = {
  packageIds?: string[];
  writeConcurrency?: number;
  writePauseMs?: number;
  onPackageStart?: (agent: CopilotPackage) => void | Promise<void>;
  onPackageResult?: (result: BulkPackageResult) => void | Promise<void>;
};

type BulkGetPackageDetailsOptions = {
  detailConcurrency?: number;
};

export class GraphPackagesClient {
  private fetcher: FetchLike;
  private retryPolicy: RetryPolicy;

  constructor(
    fetcher: FetchLike = fetch,
    retryPolicy: Partial<RetryPolicy> = {},
  ) {
    this.fetcher = fetcher;
    this.retryPolicy = { ...defaultRetryPolicy, ...retryPolicy };
  }

  async listCopilotAgents(accessToken: string) {
    const packages: CopilotPackage[] = [];
    let nextUrl: string | undefined = buildCopilotAgentsListUrl();

    while (nextUrl) {
      const page: GraphCollectionResponse<CopilotPackage> = await this.request(
        nextUrl,
        accessToken,
      );
      packages.push(...page.value);
      nextUrl = page["@odata.nextLink"];
    }

    return packages;
  }

  async getPackageDetails(accessToken: string, id: string) {
    return this.request<CopilotPackageDetail>(
      `${graphV1}/copilot/admin/catalog/packages/${encodeURIComponent(id)}`,
      accessToken,
    );
  }

  async blockPackage(accessToken: string, id: string) {
    await this.requestWithRetry<void>(
      `${graphBeta}/copilot/admin/catalog/packages/${encodeURIComponent(id)}/block`,
      accessToken,
      { method: "POST" },
    );
  }

  async unblockPackage(accessToken: string, id: string) {
    await this.requestWithRetry<void>(
      `${graphBeta}/copilot/admin/catalog/packages/${encodeURIComponent(id)}/unblock`,
      accessToken,
      { method: "POST" },
    );
  }

  private async request<T>(
    url: string,
    accessToken: string,
    init: RequestInit = {},
  ): Promise<T> {
    const response = await this.fetcher(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        ...init.headers,
      },
    });

    if (!response.ok) {
      throw await graphError(response);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  private async requestWithRetry<T>(
    url: string,
    accessToken: string,
    init: RequestInit,
  ): Promise<T> {
    for (
      let attempt = 1;
      attempt <= this.retryPolicy.maxAttempts;
      attempt += 1
    ) {
      try {
        return await this.request<T>(url, accessToken, init);
      } catch (error) {
        if (
          !(error instanceof AppError) ||
          attempt === this.retryPolicy.maxAttempts ||
          !isRetryableGraphError(error)
        ) {
          throw error;
        }

        await this.retryPolicy.delay(
          getRetryDelayMs(error, attempt, this.retryPolicy),
        );
      }
    }

    throw new AppError(
      500,
      "retry_exhausted",
      "Retry attempts were exhausted.",
    );
  }
}

export function buildCopilotAgentsListUrl() {
  const url = new URL(`${graphV1}/copilot/admin/catalog/packages`);
  url.searchParams.set("$filter", copilotFilter);
  return url.toString();
}

export async function bulkSetBlockedState(
  client: GraphPackagesClient,
  accessToken: string,
  targetBlockedState: boolean,
  options: BulkSetBlockedStateOptions = {},
): Promise<BulkActionResult> {
  const packages = await client.listCopilotAgents(accessToken);
  const requestedIds = options.packageIds
    ? new Set(options.packageIds)
    : undefined;
  const scopedPackages = requestedIds
    ? packages.filter((agent) => requestedIds.has(agent.id))
    : packages;
  const results: BulkPackageResult[] = [];
  const writeConcurrency = normalizePositiveInteger(
    options.writeConcurrency,
    bulkWriteConcurrency,
  );
  const writePauseMs = options.writePauseMs ?? bulkWritePauseMs;
  const recordSkippedResult = async (result: BulkPackageResult) => {
    results.push(result);
    await options.onPackageResult?.(result);
  };

  const actionable: CopilotPackage[] = [];

  if (requestedIds) {
    const packageIds = new Set(packages.map((agent) => agent.id));

    for (const id of requestedIds) {
      if (!packageIds.has(id)) {
        await recordSkippedResult({
          id,
          displayName: id,
          status: "failed",
          message: "Package was not found in the Copilot catalog.",
        });
      }
    }
  }

  for (const agent of scopedPackages) {
    if (agent.isBlocked === targetBlockedState) {
      await options.onPackageStart?.(agent);
      await recordSkippedResult({
        id: agent.id,
        displayName: agent.displayName,
        status: "skipped",
        message: targetBlockedState ? "Already blocked" : "Already unblocked",
      });
      continue;
    }

    actionable.push(agent);
  }

  const taskResults = await mapWithConcurrency(
    actionable,
    writeConcurrency,
    async (agent) => {
      await options.onPackageStart?.(agent);
      let result: BulkPackageResult;

      try {
        if (writePauseMs > 0) {
          await delay(writePauseMs);
        }

        if (targetBlockedState) {
          await client.blockPackage(accessToken, agent.id);
        } else {
          await client.unblockPackage(accessToken, agent.id);
        }

        result = {
          id: agent.id,
          displayName: agent.displayName,
          status: "succeeded" as const,
        };
      } catch (error) {
        result = {
          id: agent.id,
          displayName: agent.displayName,
          status: "failed" as const,
          message:
            error instanceof Error ? error.message : "Unknown Graph error",
        };
      }

      await options.onPackageResult?.(result);
      return result;
    },
  );

  results.push(...taskResults);

  return {
    targetBlockedState,
    total: requestedIds?.size ?? packages.length,
    succeeded: results.filter((result) => result.status === "succeeded").length,
    failed: results.filter((result) => result.status === "failed").length,
    skipped: results.filter((result) => result.status === "skipped").length,
    results,
  };
}

export async function bulkGetPackageDetails(
  client: GraphPackagesClient,
  accessToken: string,
  ids: string[],
  options: BulkGetPackageDetailsOptions = {},
): Promise<BulkPackageDetailsResult> {
  const detailConcurrency = normalizePositiveInteger(
    options.detailConcurrency,
    bulkDetailConcurrency,
  );
  const results = await mapWithConcurrency(
    ids,
    detailConcurrency,
    async (id): Promise<BulkPackageDetailResult> => {
      try {
        return {
          id,
          status: "succeeded",
          package: await client.getPackageDetails(accessToken, id),
        };
      } catch (error) {
        return {
          id,
          status: "failed",
          message:
            error instanceof Error ? error.message : "Unknown Graph error",
        };
      }
    },
  );

  return {
    total: ids.length,
    succeeded: results.filter((result) => result.status === "succeeded").length,
    failed: results.filter((result) => result.status === "failed").length,
    results,
  };
}

async function graphError(response: Response) {
  let details: unknown;
  let message = `Microsoft Graph request failed with status ${response.status}.`;
  let code = "graph_error";

  try {
    details = await response.json();
    const graphDetails = details as {
      error?: { code?: string; message?: string };
      Message?: string;
      message?: string;
      StatusCode?: number | string;
    };
    message =
      graphDetails.error?.message ??
      graphDetails.Message ??
      graphDetails.message ??
      message;
    code =
      graphDetails.error?.code ?? graphDetails.StatusCode?.toString() ?? code;
  } catch {
    const body = await response.text().catch(() => "");
    if (body) {
      message = body;
      details = body;
    }
  }

  return new AppError(response.status, code, message, {
    graph: details,
    retryAfterMs: retryAfterMs(response.headers.get("Retry-After")),
  });
}

function isRetryableGraphError(error: AppError) {
  return (
    error.status === 429 ||
    error.status === 503 ||
    error.status === 504 ||
    (error.status === 424 &&
      error.message.toLowerCase().includes("too many requests"))
  );
}

function getRetryDelayMs(
  error: AppError,
  attempt: number,
  retryPolicy: RetryPolicy,
) {
  const retryAfter = retryAfterFromDetails(error.details);

  if (retryAfter !== undefined) {
    return Math.min(retryAfter, retryPolicy.maxDelayMs);
  }

  return Math.min(
    retryPolicy.baseDelayMs * 2 ** (attempt - 1),
    retryPolicy.maxDelayMs,
  );
}

function retryAfterFromDetails(details: unknown) {
  if (typeof details === "object" && details && "retryAfterMs" in details) {
    const retryAfter = (details as { retryAfterMs?: unknown }).retryAfterMs;
    return typeof retryAfter === "number" ? retryAfter : undefined;
  }

  return undefined;
}

function retryAfterMs(value: string | null) {
  if (!value) {
    return undefined;
  }

  const seconds = Number.parseInt(value, 10);

  if (!Number.isNaN(seconds)) {
    return seconds * 1000;
  }

  const date = Date.parse(value);

  if (!Number.isNaN(date)) {
    return Math.max(0, date - Date.now());
  }

  return undefined;
}

async function mapWithConcurrency<T, U>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<U>,
) {
  const results: U[] = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await mapper(items[currentIndex]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );

  return results;
}

function normalizePositiveInteger(value: number | undefined, fallback: number) {
  if (value === undefined) {
    return fallback;
  }

  const normalized = Math.trunc(value);
  return Number.isSafeInteger(normalized) && normalized > 0
    ? normalized
    : fallback;
}
