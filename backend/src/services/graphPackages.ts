import { AppError, errorTelemetry } from "../errors.js";
import { allowlistedPackage } from "./packageObservation.js";
import { capturePackageMutationState, packageMutationStatesEqual, type PackageMutationState } from "./packageMutationState.js";
import { boundedProviderJson, boundedProviderText } from "./providerJson.js";
import { operationalLog } from "./telemetry.js";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { normalizePackageStatus } from "../types/copilotPackage.js";
import type {
  BulkActionResult,
  BulkPackageDetailResult,
  BulkPackageDetailsResult,
  BulkPackageResult,
  BulkSideEffectError,
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
export const packageInventoryReadPolicy = { minimumReadIntervalMs: 250, maxThrottleAttempts: 6 };
const maximumRetryAfterMs = 5 * 60_000;
const copilotFilter = "supportedHosts/any(h:h eq 'Copilot')";
const bulkDetailConcurrency = 6;
const bulkWriteConcurrency = 4;
const bulkWritePauseMs = 250;
const defaultRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 2_000,
  maxDelayMs: 30_000,
  throttleBaseDelayMs: 30_000,
  maxThrottleDelayMs: 120_000,
  minimumReadIntervalMs: 0,
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
  now: () => number;
  delay: (delayMs: number, signal?: AbortSignal) => Promise<unknown>;
};

type BulkSetBlockedStateOptions = {
  packageIds?: string[];
  writeConcurrency?: number;
  writePauseMs?: number;
  onPackageStart?: (agent: CopilotPackage) => void | Promise<void>;
  onPackageResult?: (result: BulkPackageResult) => void | Promise<void>;
};

type BulkUpdatePackageAccessOptions = {
  packageIds: string[];
  writeConcurrency?: number;
  writePauseMs?: number;
  onPackageStart?: (agent: CopilotPackage) => void | Promise<void>;
  onPackageResult?: (result: BulkPackageResult) => void | Promise<void>;
};

type BulkGetPackageDetailsOptions = {
  detailConcurrency?: number;
};

export type PackageReadOptions = {
  signal?: AbortSignal;
  correlationId?: string;
  onProgress?: (progress: { pages: number; observedCount: number }) => void | Promise<void>;
  onRetry?: (retry: { attempt: number; retryDelayMs: number; throttled: boolean }) => void | Promise<void>;
};

export type PackageMutationOptions = {
  signal?: AbortSignal;
  correlationId: string;
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

  constructor(
    fetcher: FetchLike = fetch,
    retryPolicy: Partial<RetryPolicy> = {},
  ) {
    this.fetcher = fetcher;
    this.retryPolicy = { ...defaultRetryPolicy, ...retryPolicy,
      maxThrottleAttempts: retryPolicy.maxThrottleAttempts ?? retryPolicy.maxAttempts ?? defaultRetryPolicy.maxAttempts };
  }

  async listCopilotAgents(accessToken: string, options: PackageReadOptions = {}) {
    const packages: CopilotPackage[] = [];
    let nextUrl: string | undefined = buildCopilotAgentsListUrl();
    const visited = new Set<string>();

    while (nextUrl) {
      if (visited.has(nextUrl) || visited.size >= 100 || packages.length >= 5000) {
        throw new AppError(502, "provider_result_limit", "Package inventory exceeded the bounded page/result limit.");
      }
      visited.add(nextUrl);
      const page: GraphCollectionResponse<CopilotPackage> =
        await this.requestReadWithRetry(nextUrl, accessToken, options);
      if (!page || !Array.isArray(page.value) || page.value.length + packages.length > 5000) throw new AppError(502, "provider_schema", "Package collection is invalid or oversized.");
      const nextLink = page["@odata.nextLink"];
      if (nextLink !== undefined && (typeof nextLink !== "string" || !nextLink.trim())) {
        throw new AppError(502, "provider_schema", "Package collection continuation link is invalid.");
      }
      packages.push(...page.value.map(allowlistedPackage));
      await options.onProgress?.({ pages: visited.size, observedCount: packages.length });
      nextUrl = nextLink;
    }

    return packages;
  }

  async checkCatalogAccess(accessToken: string, signal?: AbortSignal) {
    const page = await this.requestReadWithRetry<GraphCollectionResponse<CopilotPackage>>(
      buildCopilotAgentsListUrl(),
      accessToken,
      { signal },
    );
    if (!page || !Array.isArray(page.value)) throw new AppError(502, "provider_schema", "Package access check returned an invalid collection.");
    page.value.forEach(allowlistedPackage);
  }

  async getPackageDetails(accessToken: string, id: string, options: PackageReadOptions = {}) {
    return allowlistedPackage(await this.requestReadWithRetry<CopilotPackageDetail>(
      `${graphV1}/copilot/admin/catalog/packages/${encodeURIComponent(id)}`,
      accessToken,
      options,
    ));
  }

  async blockPackage(accessToken: string, id: string, options: PackageMutationOptions = { correlationId: randomUUID() }) {
    await this.requestMutationOnce<void>(
      `${graphBeta}/copilot/admin/catalog/packages/${encodeURIComponent(id)}/block`,
      accessToken,
      { method: "POST" },
      options,
    );
  }

  async unblockPackage(accessToken: string, id: string, options: PackageMutationOptions = { correlationId: randomUUID() }) {
    await this.requestMutationOnce<void>(
      `${graphBeta}/copilot/admin/catalog/packages/${encodeURIComponent(id)}/unblock`,
      accessToken,
      { method: "POST" },
      options,
    );
  }

  async patchPackageAccess(
    accessToken: string,
    id: string,
    payload: Record<string, PackageAccessEntity[]>,
    options: PackageMutationOptions = { correlationId: randomUUID() },
  ) {
    await this.requestMutationOnce<void>(
      `${graphBeta}/copilot/admin/catalog/packages/${encodeURIComponent(id)}`,
      accessToken,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      options,
    );
  }

  async reassignPackage(accessToken: string, id: string, userId: string, options: PackageMutationOptions = { correlationId: randomUUID() }) {
    await this.requestMutationOnce<void>(
      `${graphBeta}/copilot/admin/catalog/packages/${encodeURIComponent(id)}/reassign`,
      accessToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      },
      options,
    );
  }

  private async request<T>(
    url: string,
    accessToken: string,
    init: RequestInit = {},
    options: PackageReadOptions | PackageMutationOptions = {},
  ): Promise<T> {
    const target = URL.parse(url);
    if (!target || target.origin !== "https://graph.microsoft.com" || target.username || target.password || !/^\/(v1\.0|beta)\/copilot\/admin\/catalog\/packages(?:\/|$)/.test(target.pathname)) {
      throw new AppError(502, "invalid_provider_link", "Provider pagination left the documented package endpoint.");
    }
    options.signal?.throwIfAborted();
    const correlationId = options.correlationId ?? randomUUID();
    const read = !init.method || init.method === "GET";
    const timeoutSignal = AbortSignal.timeout(read ? packageReadTimeoutMs : 10_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
    try {
      const response = await this.fetcher(url, {
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

      if (!response.ok) throw await graphError(response, signal);
      if (response.status === 204) return undefined as T;
      return await boundedProviderJson<T>(response, signal);
    } catch (error) {
      options.signal?.throwIfAborted();
      if (read && timeoutSignal.aborted) {
        throw new AppError(504, "provider_timeout", "Microsoft Graph did not finish the package read within 30 seconds.");
      }
      signal.throwIfAborted();
      if (error instanceof TypeError) throw new AppError(502, "provider_network_error", "Microsoft Graph could not be reached.");
      throw error;
    }
  }

  private async requestReadWithRetry<T>(
    url: string,
    accessToken: string,
    options: PackageReadOptions,
  ): Promise<T> {
    for (
      let attempt = 1;
      attempt <= Math.max(this.retryPolicy.maxAttempts, this.retryPolicy.maxThrottleAttempts);
      attempt += 1
    ) {
      await this.waitForReadSlot(options.signal);
      try {
        return await this.request<T>(url, accessToken, {}, options);
      } catch (error) {
        options.signal?.throwIfAborted();
        const throttled = error instanceof AppError && isGraphThrottling(error);
        const retryable = error instanceof AppError && isRetryableGraphError(error);
        const retryDelayMs = retryable ? getRetryDelayMs(error, attempt, this.retryPolicy) : undefined;
        if (throttled && this.retryPolicy.minimumReadIntervalMs > 0) {
          const cooldownMs = retryDelayMs ?? retryAfterFromDetails(error.details);
          if (cooldownMs !== undefined && this.retryPolicy.now() + cooldownMs > this.cooldownUntil) {
            this.cooldownUntil = this.retryPolicy.now() + cooldownMs;
            this.cooldownError = error;
          }
        }
        const pathname = URL.parse(url)?.pathname;
        const fields = {
          provider: "graph_packages",
          stage: pathname === undefined ? "pagination" : pathname.endsWith("/packages") ? "catalog" : "identity",
          attempt,
          ...graphErrorTelemetry(error),
        };
        if (
          !retryable ||
          attempt >= (throttled ? this.retryPolicy.maxThrottleAttempts : this.retryPolicy.maxAttempts) ||
          retryDelayMs === undefined
        ) {
          operationalLog("warn", "package_provider_read_failed", fields);
          throw error;
        }

        operationalLog("warn", "package_provider_read_retry", { ...fields, retryDelayMs });
        await options.onRetry?.({ attempt, retryDelayMs, throttled });
        await waitForReadRetry(this.retryPolicy.delay, retryDelayMs, options.signal);
      }
    }

    throw new AppError(
      500,
      "retry_exhausted",
      "Retry attempts were exhausted.",
    );
  }

  private async waitForReadSlot(signal?: AbortSignal) {
    if (this.retryPolicy.minimumReadIntervalMs === 0) return;
    const admission = this.readQueue.then(async () => {
      signal?.throwIfAborted();
      for (;;) {
        const now = this.retryPolicy.now();
        if (this.cooldownUntil - now > maximumRetryAfterMs && this.cooldownError) throw this.cooldownError;
        const waitMs = Math.max(this.nextReadAt, this.cooldownUntil) - now;
        if (waitMs <= 0) break;
        await waitForReadRetry(this.retryPolicy.delay, waitMs, signal);
      }
      signal?.throwIfAborted();
      this.nextReadAt = this.retryPolicy.now() + this.retryPolicy.minimumReadIntervalMs;
    });
    // A cancelled waiter must not reject the admission queue for other jobs.
    this.readQueue = admission.then(() => undefined, () => undefined);
    await waitForReadRetry(() => admission, 0, signal);
  }

  private requestMutationOnce<T>(url: string, accessToken: string, init: RequestInit, options: PackageMutationOptions) {
    return this.request<T>(url, accessToken, init, options);
  }
}

export async function updatePackageAccess(
  client: GraphPackagesClient,
  accessToken: string,
  id: string,
  update: PackageAccessUpdate,
  currentDetails?: CopilotPackageDetail,
  beforeWrite?: () => Promise<string | void>,
  mutationOptions?: PackageMutationOptions,
): Promise<PackageAccessUpdateResult> {
  const property = accessCollectionProperty(update.target);
  const requested = deduplicateAccessEntities(update.principals);

  if (update.scope === "none") {
    if (update.mode !== "replace" || requested.length > 0) {
      throw new AppError(
        400,
        "invalid_access_update",
        "No users requires replace mode and no principals.",
      );
    }
  } else if (requested.length === 0) {
    throw new AppError(
      400,
      "invalid_access_update",
      "At least one principal is required for specific access.",
    );
  }

  const details =
    currentDetails ?? (await client.getPackageDetails(accessToken, id));
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

    resulting = deduplicateAccessEntities([...previous, ...requested]);
  }

  if (
    currentScope === desiredScope &&
    sameAccessEntities(previous, resulting)
  ) {
    return {
      changed: false,
      previousCount: previous.length,
      resultingCount: resulting.length,
      principals: resulting,
    };
  }

  const unselectedProperty =
    update.target === "availability"
      ? ("acquireUsersAndGroups" as const)
      : ("allowedUsersAndGroups" as const);

  if (details[unselectedProperty] === undefined) {
    throw new AppError(
      409,
      "incomplete_package_access_state",
      `Microsoft Graph did not return ${unselectedProperty}, so the documented full access payload cannot be sent safely.`,
    );
  }

  const dispatchToken = await beforeWrite?.() ?? accessToken;
  const payload = {
    allowedUsersAndGroups:
      update.target === "availability"
        ? resulting
        : deduplicateAccessEntities(details.allowedUsersAndGroups ?? []),
    acquireUsersAndGroups:
      update.target === "installation"
        ? resulting
        : deduplicateAccessEntities(details.acquireUsersAndGroups ?? []),
  };
  if (mutationOptions) await client.patchPackageAccess(dispatchToken, id, payload, mutationOptions);
  else await client.patchPackageAccess(dispatchToken, id, payload);

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
    const details = await client.getPackageDetails(accessToken, id, options);
    if (details.id !== id) throw new AppError(502, "target_mismatch", "Provider returned a different package identity.");
    lastState = capturePackageMutationState(details, action);
    if (packageMutationStatesEqual(lastState, expectedState)) return { details, state: lastState, readbackCount: attempt };
    if (attempt < maxAttempts && delayMs > 0) await waitForReadRetry(wait, delayMs, options.signal);
  }
  throw new AppError(409, "verification_inconclusive", "Microsoft Graph accepted the request but the expected package state did not converge within the bounded readback window.", { expectedState, lastState, readbackCount: maxAttempts });
}

export function verifyPackageAccessApplied(
  details: CopilotPackageDetail,
  update: PackageAccessUpdate,
  expectedPrincipals: PackageAccessEntity[],
  previousDetails: CopilotPackageDetail,
) {
  const property = accessCollectionProperty(update.target);
  const actualPrincipals = deduplicateAccessEntities(details[property] ?? []);
  const actualScope = inferCurrentAccessScope(
    details,
    update.target,
    actualPrincipals,
  );
  const expectedScope = update.scope === "none" ? "none" : "specific";
  const preservedTarget = otherAccessTarget(update.target);
  const preservedProperty = accessCollectionProperty(preservedTarget);
  const expectedPreservedPrincipals = deduplicateAccessEntities(
    previousDetails[preservedProperty] ?? [],
  );
  const actualPreservedPrincipals = deduplicateAccessEntities(
    details[preservedProperty] ?? [],
  );
  const expectedPreservedScope = inferCurrentAccessScope(
    previousDetails,
    preservedTarget,
    expectedPreservedPrincipals,
  );
  const actualPreservedScope = inferCurrentAccessScope(
    details,
    preservedTarget,
    actualPreservedPrincipals,
  );
  const requestedAccessApplied =
    actualScope === expectedScope &&
    sameAccessEntities(actualPrincipals, expectedPrincipals);
  const otherAccessPreserved =
    actualPreservedScope === expectedPreservedScope &&
    sameAccessEntities(actualPreservedPrincipals, expectedPreservedPrincipals);

  if (requestedAccessApplied && otherAccessPreserved) {
    return;
  }

  throw new AppError(
    409,
    "access_update_not_applied",
    requestedAccessApplied
      ? `Microsoft Graph accepted the request but changed the unselected ${formatAccessTarget(preservedTarget)} access setting.`
      : `Microsoft Graph accepted the request but did not apply the requested ${formatAccessScope(expectedScope)} access scope. Effective access is still ${formatAccessScope(actualScope)}.`,
    {
      target: update.target,
      expectedScope,
      actualScope,
      expectedPrincipals,
      actualPrincipals,
      preservedTarget,
      expectedPreservedScope,
      actualPreservedScope,
      expectedPreservedPrincipals,
      actualPreservedPrincipals,
    },
  );
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
        `${entity.resourceType.toLowerCase()}:${entity.resourceId.toLowerCase()}`,
    ),
  );

  return left.every((entity) =>
    rightKeys.has(
      `${entity.resourceType.toLowerCase()}:${entity.resourceId.toLowerCase()}`,
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

  if (principals.length > 0) {
    return "specific" as const;
  }

  return "unknown" as const;
}

function formatAccessScope(scope: "all" | "specific" | "none" | "unknown") {
  if (scope === "all") {
    return "All users";
  }

  if (scope === "specific") {
    return "Specific users or groups";
  }

  if (scope === "none") {
    return "No users";
  }

  return "Unknown";
}

function formatAccessTarget(target: PackageAccessUpdate["target"]) {
  return target === "availability" ? "Available to" : "Installed for";
}

function deduplicateAccessEntities(entities: PackageAccessEntity[]) {
  const unique = new Map<string, PackageAccessEntity>();

  for (const entity of entities) {
    const resourceId = entity.resourceId.trim();
    const resourceType = entity.resourceType.trim();

    if (!resourceId || !resourceType) {
      continue;
    }

    const key = `${resourceType.toLowerCase()}:${resourceId.toLowerCase()}`;
    unique.set(key, { resourceId, resourceType });
  }

  return [...unique.values()];
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
  const sideEffectErrors: BulkSideEffectError[] = [];
  const writeConcurrency = normalizePositiveInteger(
    options.writeConcurrency,
    bulkWriteConcurrency,
  );
  const writePauseMs = options.writePauseMs ?? bulkWritePauseMs;
  const recordSkippedResult = async (result: BulkPackageResult) => {
    results.push(result);
    await emitPackageResult(options, result, sideEffectErrors);
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
      await emitPackageStart(options, agent, sideEffectErrors);
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
      await emitPackageStart(options, agent, sideEffectErrors);
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
          errorCode: error instanceof AppError ? error.code : undefined,
          errorDetails: error instanceof AppError ? error.details : undefined,
        };
      }

      await emitPackageResult(options, result, sideEffectErrors);
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
    sideEffectErrors:
      sideEffectErrors.length > 0 ? sideEffectErrors : undefined,
  };
}

export async function bulkUpdatePackageAccess(
  client: GraphPackagesClient,
  accessToken: string,
  update: PackageAccessUpdate,
  options: BulkUpdatePackageAccessOptions,
): Promise<BulkActionResult> {
  const packages = await client.listCopilotAgents(accessToken);
  const requestedIds = new Set(options.packageIds);
  const packageById = new Map(packages.map((agent) => [agent.id, agent]));
  const results: BulkPackageResult[] = [];
  const sideEffectErrors: BulkSideEffectError[] = [];
  const writeConcurrency = normalizePositiveInteger(
    options.writeConcurrency,
    bulkWriteConcurrency,
  );
  const writePauseMs = options.writePauseMs ?? bulkWritePauseMs;

  for (const id of requestedIds) {
    if (packageById.has(id)) {
      continue;
    }

    const result: BulkPackageResult = {
      id,
      displayName: id,
      status: "failed",
      message: "Package was not found in the Copilot catalog.",
    };
    results.push(result);
    await emitPackageResult(options, result, sideEffectErrors);
  }

  const scopedPackages = [...requestedIds].flatMap((id) => {
    const agent = packageById.get(id);
    return agent ? [agent] : [];
  });
  const taskResults = await mapWithConcurrency(
    scopedPackages,
    writeConcurrency,
    async (agent): Promise<BulkPackageResult> => {
      await emitPackageStart(options, agent, sideEffectErrors);
      let result: BulkPackageResult;

      try {
        if (writePauseMs > 0) {
          await delay(writePauseMs);
        }

        const currentDetails = await client.getPackageDetails(
          accessToken,
          agent.id,
        );
        const accessResult = await updatePackageAccess(
          client,
          accessToken,
          agent.id,
          update,
          currentDetails,
        );

        if (accessResult.changed) {
          const updatedDetails = await client.getPackageDetails(
            accessToken,
            agent.id,
          );
          verifyPackageAccessApplied(
            updatedDetails,
            update,
            accessResult.principals,
            currentDetails,
          );
        }

        result = {
          id: agent.id,
          displayName: agent.displayName,
          status: accessResult.changed ? "succeeded" : "skipped",
          message: accessResult.changed ? undefined : "Access already assigned",
          accessResult,
        };
      } catch (error) {
        result = {
          id: agent.id,
          displayName: agent.displayName,
          status: "failed",
          message:
            error instanceof Error ? error.message : "Unknown Graph error",
          errorCode: error instanceof AppError ? error.code : undefined,
          errorDetails: error instanceof AppError ? error.details : undefined,
        };
      }

      await emitPackageResult(options, result, sideEffectErrors);
      return result;
    },
  );

  results.push(...taskResults);

  return {
    accessUpdate: update,
    total: requestedIds.size,
    succeeded: results.filter((result) => result.status === "succeeded").length,
    failed: results.filter((result) => result.status === "failed").length,
    skipped: results.filter((result) => result.status === "skipped").length,
    results,
    sideEffectErrors:
      sideEffectErrors.length > 0 ? sideEffectErrors : undefined,
  };
}

async function emitPackageStart(
  options: BulkSetBlockedStateOptions | BulkUpdatePackageAccessOptions,
  agent: CopilotPackage,
  sideEffectErrors: BulkSideEffectError[],
) {
  try {
    await options.onPackageStart?.(agent);
  } catch (error) {
    sideEffectErrors.push({
      phase: "start",
      agentId: agent.id,
      message: errorMessage(error),
    });
  }
}

async function emitPackageResult(
  options: BulkSetBlockedStateOptions | BulkUpdatePackageAccessOptions,
  result: BulkPackageResult,
  sideEffectErrors: BulkSideEffectError[],
) {
  try {
    await options.onPackageResult?.(result);
  } catch (error) {
    sideEffectErrors.push({
      phase: "result",
      agentId: result.id,
      message: errorMessage(error),
    });
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown side-effect error";
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

export async function graphError(response: Response, signal?: AbortSignal) {
  const body = await boundedProviderText(response, 65_536, signal).catch(() => {
    signal?.throwIfAborted();
    return "";
  });
  const message = `Microsoft Graph request failed with status ${response.status}.`;
  let code = "graph_error";
  let providerErrorCode: string | undefined;
  let throttled = response.status === 429;

  if (body) {
    try {
      const graphDetails = JSON.parse(body) as {
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
  return (
    error.code === "provider_network_error" ||
    error.code === "provider_timeout" ||
    ([500, 502].includes(error.status) && graphResponseDiagnostics(error) !== undefined) ||
    isGraphThrottling(error) ||
    error.status === 503 ||
    error.status === 504
  );
}

function isGraphThrottling(error: AppError) {
  return error.status === 429 || error.status === 424 && typeof error.details === "object" && error.details !== null
    && "throttled" in error.details && error.details.throttled === true;
}

export function graphResponseDiagnostics(error: unknown) {
  if (!(error instanceof AppError) || !Number.isInteger(error.status) || error.status < 400 || error.status > 599
    || typeof error.details !== "object" || error.details === null
    || !("httpStatus" in error.details) || error.details.httpStatus !== error.status) return undefined;
  const details = error.details;
  return {
    status: error.status,
    throttled: isGraphThrottling(error),
    providerCode: "providerErrorCode" in details && typeof details.providerErrorCode === "string"
      && /^[A-Za-z0-9_.-]{1,128}$/.test(details.providerErrorCode) ? details.providerErrorCode : undefined,
    requestId: "correlationId" in details && typeof details.correlationId === "string"
      && /^[A-Za-z0-9-]{1,128}$/.test(details.correlationId) ? details.correlationId : undefined,
  };
}

export function graphErrorTelemetry(error: unknown) {
  const diagnostics = graphResponseDiagnostics(error);
  return {
    ...errorTelemetry(error, "provider_error"),
    ...(diagnostics ? {
      errorCode: `graph_http_${diagnostics.status}`,
      reason: diagnostics.providerCode,
      providerRequestId: diagnostics.requestId,
      ...(diagnostics.throttled ? { outcome: "throttled" } : {}),
    } : error instanceof Error && !(error instanceof AppError) && /^[A-Za-z0-9_]{1,64}$/.test(error.name)
      ? { reason: error.name } : {}),
  };
}

function getRetryDelayMs(
  error: AppError,
  attempt: number,
  retryPolicy: RetryPolicy,
) {
  const retryAfter = retryAfterFromDetails(error.details);

  if (retryAfter !== undefined) {
    return retryAfter <= maximumRetryAfterMs ? retryAfter : undefined;
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

function retryAfterMs(value: string | null) {
  if (!value) {
    return undefined;
  }

  if (/^\d+$/.test(value.trim())) {
    const milliseconds = Number(value) * 1000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
  }

  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value.trim())) return undefined;
  const date = Date.parse(value);

  if (!Number.isNaN(date)) {
    return Math.max(0, date - Date.now());
  }

  return undefined;
}

async function waitForReadRetry(wait: (delayMs: number, signal?: AbortSignal) => Promise<unknown>, delayMs: number, signal?: AbortSignal) {
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
    await Promise.race([wait(delayMs, signal), aborted]);
    signal.throwIfAborted();
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    removeAbort();
  }
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
