import { AppError } from "../errors.js";
import { allowlistedPackage } from "./packageObservation.js";
import { capturePackageMutationState, packageMutationStatesEqual, type PackageMutationState } from "./packageMutationState.js";
import { boundedProviderJson, boundedProviderText } from "./providerJson.js";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
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
const copilotFilter = "supportedHosts/any(h:h eq 'Copilot')";
const bulkDetailConcurrency = 6;
const bulkWriteConcurrency = 4;
const bulkWritePauseMs = 250;
const allAccessScopeIndicators = new Set([
  "all",
  "everyone",
  "allowedforall",
  "availabletoall",
  "deployedtoall",
  "installedforall",
]);
const noAccessScopeIndicators = new Set([
  "none",
  "noone",
  "allowedfornoone",
  "availabletonoone",
  "deployedtonoone",
  "installedfornoone",
  "notavailable",
  "notdeployed",
]);
const specificAccessScopeIndicators = new Set([
  "some",
  "allowedforsome",
  "availabletosome",
  "deployedtosome",
  "installedforsome",
]);
const defaultRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 2_000,
  maxDelayMs: 30_000,
  delay,
};

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

type RetryPolicy = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  delay: (delayMs: number) => Promise<unknown>;
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

  constructor(
    fetcher: FetchLike = fetch,
    retryPolicy: Partial<RetryPolicy> = {},
  ) {
    this.fetcher = fetcher;
    this.retryPolicy = { ...defaultRetryPolicy, ...retryPolicy };
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
      if (!Array.isArray(page.value) || page.value.length + packages.length > 5000) throw new AppError(502, "provider_schema", "Package collection is invalid or oversized.");
      packages.push(...page.value.map(allowlistedPackage));
      await options.onProgress?.({ pages: visited.size, observedCount: packages.length });
      nextUrl = page["@odata.nextLink"];
    }

    return packages;
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
    const target = new URL(url);
    if (target.origin !== "https://graph.microsoft.com" || target.username || target.password || !/^\/(v1\.0|beta)\/copilot\/admin\/catalog\/packages(?:\/|$)/.test(target.pathname)) {
      throw new AppError(502, "invalid_provider_link", "Provider pagination left the documented package endpoint.");
    }
    options.signal?.throwIfAborted();
    const correlationId = options.correlationId ?? randomUUID();
    const timeoutSignal = AbortSignal.timeout(10_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
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

    if (!response.ok) {
      throw await graphError(response);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return boundedProviderJson<T>(response);
  }

  private async requestReadWithRetry<T>(
    url: string,
    accessToken: string,
    options: PackageReadOptions,
  ): Promise<T> {
    for (
      let attempt = 1;
      attempt <= this.retryPolicy.maxAttempts;
      attempt += 1
    ) {
      try {
        return await this.request<T>(url, accessToken, {}, options);
      } catch (error) {
        if (
          !(error instanceof AppError) ||
          attempt === this.retryPolicy.maxAttempts ||
          !isRetryableGraphError(error)
        ) {
          throw error;
        }

        await waitForReadRetry(this.retryPolicy.delay, getRetryDelayMs(error, attempt, this.retryPolicy), options.signal);
      }
    }

    throw new AppError(
      500,
      "retry_exhausted",
      "Retry attempts were exhausted.",
    );
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
  const wait = options.delay ?? delay;
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
  const indicator = normalizeAccessScopeIndicator(
    target === "availability" ? details.availableTo : details.deployedTo,
  );

  if (allAccessScopeIndicators.has(indicator)) {
    return "all" as const;
  }

  if (noAccessScopeIndicators.has(indicator)) {
    return "none" as const;
  }

  if (specificAccessScopeIndicators.has(indicator)) {
    return "specific" as const;
  }

  if (principals.length > 0) {
    return "specific" as const;
  }

  return "unknown" as const;
}

function normalizeAccessScopeIndicator(value: string | undefined) {
  return value?.replace(/[^a-z0-9]/gi, "").toLowerCase() ?? "";
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

export async function graphError(response: Response) {
  const body = await boundedProviderText(response, 65_536).catch(() => "");
  let details: unknown;
  let message = `Microsoft Graph request failed with status ${response.status}.`;
  let code = "graph_error";

  if (body) {
    try {
      details = JSON.parse(body) as unknown;
      const graphDetails = details as {
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
      if (typeof providerMessage === "string") message = providerMessage.slice(0, 1024);
      if (typeof providerCode === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(providerCode)) code = providerCode;
      details = { error: { code, message } };
    } catch {
      message = body.slice(0, 1024);
      details = message;
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

async function waitForReadRetry(wait: (delayMs: number) => Promise<unknown>, delayMs: number, signal?: AbortSignal) {
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
