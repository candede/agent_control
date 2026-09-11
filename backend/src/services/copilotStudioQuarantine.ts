import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { AppError } from "../errors.js";
import type { CopilotStudioQuarantineStatus, CopilotStudioQuarantineTarget } from "../types/copilotStudioQuarantine.js";
import { boundedProviderText } from "./providerJson.js";

const quarantineOrigin = "https://api.powerplatform.com";
const quarantineApiVersion = "1";
const maximumResponseBytes = 65_536;
const defaultRequestTimeoutMs = 10_000;
const defaultReadOperationTimeoutMs = 30_000;
const nativeIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const environmentIdPattern = new RegExp(`^(?:Default-)?${nativeIdPattern.source.slice(1, -1)}$`, "i");

export type { CopilotStudioQuarantineStatus, CopilotStudioQuarantineTarget } from "../types/copilotStudioQuarantine.js";

export type QuarantineReadOptions = {
  signal?: AbortSignal;
  correlationId?: string;
};

export type QuarantineMutationOptions = {
  signal?: AbortSignal;
  correlationId: string;
};

export type QuarantineReadbackOptions = QuarantineReadOptions & {
  maxAttempts?: number;
  delayMs?: number;
  delay?: (delayMs: number) => Promise<unknown>;
};

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

type RetryPolicy = {
  maxAttempts: number;
  baseDelayMs: number;
  maximumDelayMs: number;
  delay: (delayMs: number) => Promise<unknown>;
};

const defaultRetryPolicy: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maximumDelayMs: 10_000,
  delay,
};

export class CopilotStudioQuarantineClient {
  private readonly retryPolicy: RetryPolicy;

  constructor(
    private readonly fetcher: FetchLike = fetch,
    retryPolicy: Partial<RetryPolicy> = {},
    private readonly requestTimeoutMs = defaultRequestTimeoutMs,
    private readonly now: () => Date = () => new Date(),
    private readonly readOperationTimeoutMs = defaultReadOperationTimeoutMs,
  ) {
    this.retryPolicy = { ...defaultRetryPolicy, ...retryPolicy };
  }

  async getStatus(accessToken: string, target: CopilotStudioQuarantineTarget, options: QuarantineReadOptions = {}) {
    const validatedTarget = validateQuarantineTarget(target);
    const correlationId = options.correlationId ?? randomUUID();
    const url = buildCopilotStudioQuarantineUrl(validatedTarget);
    const operationTimeout = AbortSignal.timeout(this.readOperationTimeoutMs);
    const operationSignal = options.signal ? AbortSignal.any([options.signal, operationTimeout]) : operationTimeout;

    for (let attempt = 1; attempt <= this.retryPolicy.maxAttempts; attempt += 1) {
      try {
        return await this.requestStatus(url, accessToken, { method: "GET" }, validatedTarget, correlationId, operationSignal);
      } catch (error) {
        if (operationSignal.aborted) throw normalizedAbort(operationSignal);
        if (attempt === this.retryPolicy.maxAttempts || !isRetryableReadError(error)) throw error;
        const waitMs = error instanceof AppError && retryAfterFromDetails(error.details) !== undefined
          ? Math.min(retryAfterFromDetails(error.details)!, this.retryPolicy.maximumDelayMs)
          : Math.min(this.retryPolicy.baseDelayMs * 2 ** (attempt - 1), this.retryPolicy.maximumDelayMs);
        try {
          await waitForRetry(this.retryPolicy.delay, waitMs, operationSignal);
        } catch (waitError) {
          if (operationSignal.aborted) throw normalizedAbort(operationSignal);
          throw waitError;
        }
      }
    }

    throw new AppError(500, "retry_exhausted", "Copilot Studio quarantine status retry attempts were exhausted.");
  }

  setQuarantine(
    accessToken: string,
    target: CopilotStudioQuarantineTarget,
    isBotQuarantined: boolean,
    options: QuarantineMutationOptions,
  ) {
    const validatedTarget = validateQuarantineTarget(target);
    return this.requestStatus(
      buildCopilotStudioQuarantineUrl(validatedTarget, isBotQuarantined ? "SetAsQuarantined" : "SetAsUnquarantined"),
      accessToken,
      { method: "POST" },
      validatedTarget,
      options.correlationId,
      options.signal,
    );
  }

  private async requestStatus(
    url: string,
    accessToken: string,
    init: RequestInit,
    target: CopilotStudioQuarantineTarget,
    correlationId: string,
    callerSignal?: AbortSignal,
  ): Promise<CopilotStudioQuarantineStatus> {
    callerSignal?.throwIfAborted();
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
    try {
      const response = await this.fetcher(url, {
        ...init,
        signal,
        redirect: "error",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          "x-ms-client-request-id": correlationId,
        },
      });
      if (response.redirected || response.url && !isQuarantineProviderUrl(response.url)) {
        await disposeResponse(response);
        throw new AppError(502, "invalid_provider_link", "Copilot Studio quarantine refused a redirected or foreign provider response.");
      }
      if (!response.ok) throw await quarantineProviderError(response, signal);
      if (response.status !== 200) {
        await disposeResponse(response);
        throw new AppError(502, "provider_unexpected_status", "Copilot Studio quarantine returned an unexpected success status.");
      }
      const text = await boundedProviderText(response, maximumResponseBytes, signal);
      return {
        ...target,
        ...parseQuarantineStatus(text),
        observedAt: this.now().toISOString(),
        correlationId,
      };
    } catch (error) {
      if (callerSignal?.aborted) throw normalizedAbort(callerSignal);
      if (timeoutSignal.aborted) throw normalizedAbort(timeoutSignal);
      throw error;
    }
  }
}

export async function verifyCopilotStudioQuarantineConverged(
  client: Pick<CopilotStudioQuarantineClient, "getStatus">,
  accessToken: string,
  target: CopilotStudioQuarantineTarget,
  requestedState: boolean,
  options: QuarantineReadbackOptions = {},
) {
  const maxAttempts = Math.min(Math.max(Math.trunc(options.maxAttempts ?? 5), 1), 20);
  const delayMs = Math.min(Math.max(Math.trunc(options.delayMs ?? 500), 0), 5_000);
  const wait = options.delay ?? delay;
  let lastStatus: CopilotStudioQuarantineStatus | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    lastStatus = await client.getStatus(accessToken, target, options);
    if (lastStatus.isBotQuarantined === requestedState) return { status: lastStatus, readbackCount: attempt };
    if (attempt < maxAttempts && delayMs > 0) await waitForRetry(wait, delayMs, options.signal);
  }
  throw new AppError(409, "verification_inconclusive", "Copilot Studio accepted the request but the expected quarantine state did not converge within the bounded readback window.", { lastStatus, readbackCount: maxAttempts });
}

export function buildCopilotStudioQuarantineUrl(
  target: CopilotStudioQuarantineTarget,
  action?: "SetAsQuarantined" | "SetAsUnquarantined",
) {
  const validatedTarget = validateQuarantineTarget(target);
  const path = `/copilotstudio/environments/${encodeURIComponent(validatedTarget.environmentId)}/bots/${encodeURIComponent(validatedTarget.botId)}/api/botQuarantine${action ? `/${action}` : ""}`;
  const url = new URL(path, quarantineOrigin);
  url.searchParams.set("api-version", quarantineApiVersion);
  return url.toString();
}

export function validateQuarantineTarget(target: CopilotStudioQuarantineTarget) {
  if (!target || typeof target.environmentId !== "string" || !environmentIdPattern.test(target.environmentId)) {
    throw new AppError(400, "invalid_quarantine_target", "Copilot Studio quarantine requires an exact native environment ID.");
  }
  if (typeof target.botId !== "string" || !nativeIdPattern.test(target.botId)) {
    throw new AppError(400, "invalid_quarantine_target", "Copilot Studio quarantine requires an exact native bot ID.");
  }
  return target;
}

function parseQuarantineStatus(text: string) {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new AppError(502, "provider_schema", "Copilot Studio quarantine returned invalid JSON.");
  }
  if (!isRecord(value) || typeof value.isBotQuarantined !== "boolean" || !isUtcDateTime(value.lastUpdateTimeUtc)) {
    throw new AppError(502, "provider_schema", "Copilot Studio quarantine returned an invalid status shape.");
  }
  return {
    isBotQuarantined: value.isBotQuarantined,
    lastUpdateTimeUtc: value.lastUpdateTimeUtc,
  };
}

async function quarantineProviderError(response: Response, signal: AbortSignal) {
  const body = await boundedProviderText(response, maximumResponseBytes, signal).catch(() => {
    if (signal.aborted) throw normalizedAbort(signal);
    return "";
  });
  let providerCode: string | undefined;
  if (body) {
    try {
      const value = JSON.parse(body) as unknown;
      if (isRecord(value)) {
        const error = isRecord(value.error) ? value.error : value;
        if (typeof error.code === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(error.code)) providerCode = error.code;
      }
    } catch {
      providerCode = undefined;
    }
  }
  const code = response.status === 405 ? "classic_bot_unsupported"
    : response.status === 404 ? "quarantine_target_removed"
      : response.status === 429 ? "provider_throttled"
        : explicitProviderErrorCode(providerCode, response.headers)
          ?? (response.status === 401 || response.status === 403 ? "provider_authorization_error" : "provider_error");
  return new AppError(response.status, code, quarantineErrorMessage(code), {
    retryAfterMs: retryAfterMs(response.headers.get("retry-after")),
  });
}

function explicitProviderErrorCode(providerCode: string | undefined, headers: Headers) {
  const normalized = providerCode?.toLowerCase();
  if (normalized === "conditionalaccessblocked" || normalized === "insufficient_claims" || /\bclaims=/i.test(headers.get("www-authenticate") ?? "")) return "conditional_access_required";
  if (normalized === "missingrequireddelegatedpermission" || normalized === "missingscope") return "missing_provider_scope";
  if (normalized === "missingproviderrole" || normalized === "insufficientrole") return "missing_provider_role";
  if (normalized === "featureNotAvailable".toLowerCase() || normalized === "apinotenabled") return "quarantine_rollout_unavailable";
  return undefined;
}

function quarantineErrorMessage(code: string) {
  if (code === "classic_bot_unsupported") return "Classic Copilot Studio bots do not support quarantine operations.";
  if (code === "quarantine_target_removed") return "The exact Copilot Studio quarantine target was not found.";
  if (code === "provider_throttled") return "Copilot Studio quarantine was throttled by the provider.";
  if (code === "conditional_access_required") return "Copilot Studio quarantine returned an explicit conditional access challenge.";
  if (code === "missing_provider_scope") return "Copilot Studio quarantine explicitly rejected the required delegated permission scope.";
  if (code === "missing_provider_role") return "Copilot Studio quarantine explicitly rejected the required provider role.";
  if (code === "quarantine_rollout_unavailable") return "Copilot Studio quarantine explicitly reported that the API is not available for this target.";
  if (code === "provider_authorization_error") return "Copilot Studio quarantine authorization, provider role, or access policy was not accepted.";
  return "Copilot Studio quarantine request failed.";
}

function isRetryableReadError(error: unknown) {
  if (!(error instanceof AppError)) return true;
  return error.status === 429 || error.status === 503 || error.status === 504;
}

function retryAfterFromDetails(details: unknown) {
  if (!isRecord(details)) return undefined;
  return typeof details.retryAfterMs === "number" ? details.retryAfterMs : undefined;
}

function retryAfterMs(value: string | null) {
  if (!value) return undefined;
  const seconds = Number.parseInt(value, 10);
  if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

async function waitForRetry(wait: (delayMs: number) => Promise<unknown>, delayMs: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!signal) {
    await wait(delayMs);
    return;
  }
  let removeAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbort = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    await Promise.race([wait(delayMs), aborted]);
  } finally {
    removeAbort();
  }
}

function isQuarantineProviderUrl(value: string) {
  const url = new URL(value);
  return url.origin === quarantineOrigin && /^\/copilotstudio\/environments\/[^/]+\/bots\/[^/]+\/api\/botQuarantine(?:\/(?:SetAsQuarantined|SetAsUnquarantined))?$/.test(url.pathname) && url.searchParams.get("api-version") === quarantineApiVersion;
}

async function disposeResponse(response: Response) {
  await response.body?.cancel().catch(() => undefined);
}

function normalizedAbort(signal: AbortSignal) {
  const reason = signal.reason;
  return reason instanceof DOMException && reason.name === "TimeoutError"
    ? new AppError(504, "provider_timeout", "Copilot Studio quarantine exceeded its bounded operation deadline.")
    : reason instanceof Error ? reason : new AppError(499, "request_cancelled", "Copilot Studio quarantine was cancelled.");
}

function isUtcDateTime(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}