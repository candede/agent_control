import { AppError, isTimeoutError } from "../errors.js";
import { isDirectoryObjectId, type PackageAccessEntity } from "../types/copilotPackage.js";
import { graphError, graphResponseError, type FetchLike } from "./graphPackages.js";
import { boundedProviderJson, parseProviderContractJson } from "./providerJson.js";

const graphV1 = "https://graph.microsoft.com/v1.0";
const defaultSearchLimit = 25;
const maxSearchLimit = 50;
const maxSearchQueryLength = 120;
const maxResolveCount = 500;
const resolveConcurrency = 8;

type GraphUser = {
  id: string;
  displayName?: string;
  mail?: string;
  userPrincipalName?: string;
};

type GraphGroup = {
  id: string;
  displayName?: string;
  description?: string;
  mail?: string;
  groupTypes?: string[];
  securityEnabled?: boolean;
};

type GraphCollection<T> = {
  value: T[];
};

export type DirectoryPrincipal = PackageAccessEntity & {
  displayName: string;
  secondaryText?: string;
  principalKind: "user" | "securityGroup" | "microsoft365Group" | "unknown";
  userPrincipalName?: string;
};

export class DirectoryPrincipalsClient {
  constructor(private readonly fetcher: FetchLike = fetch) {}

  async search(accessToken: string, query: string, limit = defaultSearchLimit, signal?: AbortSignal, assertCurrent?: () => void) {
    signal?.throwIfAborted();
    assertCurrent?.();
    if (typeof query !== "string" || /[\u0000-\u001f\u007f-\u009f]/.test(query)) {
      throw new AppError(400, "invalid_directory_search", "Directory searches must be text without control characters.");
    }
    const normalizedQuery = query.trim();

    if (normalizedQuery.length < 2) {
      throw new AppError(
        400,
        "invalid_directory_search",
        "Enter at least two characters to search the directory.",
      );
    }

    if (normalizedQuery.length > maxSearchQueryLength) {
      throw new AppError(
        400,
        "invalid_directory_search",
        `Directory searches cannot exceed ${maxSearchQueryLength} characters.`,
      );
    }

    const normalizedLimit = Math.min(
      Math.max(Math.trunc(limit) || defaultSearchLimit, 1),
      maxSearchLimit,
    );
    const controller = new AbortController();
    const batchSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      const [users, groups] = await Promise.all([
        this.searchCollection<GraphUser>(
          buildUserSearchUrl(normalizedQuery, normalizedLimit), accessToken, batchSignal, assertCurrent,
        ),
        this.searchCollection<GraphGroup>(
          buildGroupSearchUrl(normalizedQuery, normalizedLimit), accessToken, batchSignal, assertCurrent,
        ),
      ]);
      batchSignal.throwIfAborted();
      assertCurrent?.();
      const principals = new Map<string, DirectoryPrincipal>();
      for (const principal of [
        ...users.map(mapUser),
        ...groups.filter(isAssignableGroup).map(mapGroup),
      ]) {
        const key = `${principal.resourceType}:${principal.resourceId}`;
        if (!principals.has(key)) principals.set(key, principal);
      }
      return [...principals.values()]
        .sort((left, right) =>
          left.displayName.localeCompare(right.displayName, undefined, {
            sensitivity: "base",
          }) || left.resourceType.localeCompare(right.resourceType)
            || left.resourceId.localeCompare(right.resourceId),
        )
        .slice(0, normalizedLimit);
    } catch (error) {
      controller.abort(error);
      signal?.throwIfAborted();
      assertCurrent?.();
      throw error;
    }
  }

  async resolve(accessToken: string, entities: PackageAccessEntity[], signal?: AbortSignal, assertCurrent?: () => void) {
    signal?.throwIfAborted();
    assertCurrent?.();
    if (!Array.isArray(entities)) {
      throw new AppError(400, "invalid_principals", "Directory resolution requires a principal array.");
    }
    if (entities.length > maxResolveCount) {
      throw new AppError(
        400,
        "too_many_principals",
        `A maximum of ${maxResolveCount} principals can be resolved at once.`,
      );
    }
    const unique = deduplicateEntities(entities);

    const controller = new AbortController();
    const batchSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const results = await mapWithConcurrency(
      unique,
      resolveConcurrency,
      async (entity): Promise<DirectoryPrincipal> => {
        batchSignal.throwIfAborted();
        try {
          if (entity.resourceType === "user") {
            return await this.resolveUser(accessToken, entity.resourceId, batchSignal, assertCurrent);
          }
          return await this.resolveGroup(accessToken, entity.resourceId, batchSignal, assertCurrent);
        } catch (error) {
          controller.abort(error);
          throw error;
        }
      },
    ).catch(error => {
      signal?.throwIfAborted();
      assertCurrent?.();
      throw error;
    });
    batchSignal.throwIfAborted();
    assertCurrent?.();
    return results;
  }

  private async searchCollection<T extends GraphUser | GraphGroup>(
    url: string, accessToken: string, signal: AbortSignal, assertCurrent?: () => void,
  ) {
    const collection = await this.request<GraphCollection<T>>(
      url, accessToken, { ConsistencyLevel: "eventual" }, signal, assertCurrent,
    );
    signal.throwIfAborted();
    if (!collection || !Array.isArray(collection.value) || collection.value.length > maxSearchLimit) {
      throw new AppError(502, "provider_schema", "Directory collection is invalid or oversized.");
    }
    collection.value.forEach(validatePrincipal);
    return collection.value;
  }

  private async resolveUser(accessToken: string, id: string, signal?: AbortSignal, assertCurrent?: () => void) {
    try {
      const user = await this.request<GraphUser>(
        `${graphV1}/users/${encodeURIComponent(id)}?$select=id,displayName,mail,userPrincipalName`,
        accessToken,
        {},
        signal,
        assertCurrent,
      );
      const principal = mapUser(user);
      requireResolvedIdentity(principal.resourceId, id);
      return principal;
    } catch (error) {
      signal?.throwIfAborted();
      assertCurrent?.();
      if (error instanceof AppError && error.status === 404) {
        return fallbackPrincipal({ resourceType: "user", resourceId: id });
      }
      throw error;
    }
  }

  private async resolveGroup(accessToken: string, id: string, signal?: AbortSignal, assertCurrent?: () => void) {
    try {
      const group = await this.request<GraphGroup>(
        `${graphV1}/groups/${encodeURIComponent(id)}?$select=id,displayName,description,mail,groupTypes,securityEnabled`,
        accessToken,
        {},
        signal,
        assertCurrent,
      );
      const principal = mapGroup(group);
      requireResolvedIdentity(principal.resourceId, id);
      return principal;
    } catch (error) {
      signal?.throwIfAborted();
      assertCurrent?.();
      if (error instanceof AppError && error.status === 404) {
        return fallbackPrincipal({ resourceType: "group", resourceId: id });
      }
      throw error;
    }
  }

  private async request<T>(
    url: string,
    accessToken: string,
    extraHeaders: Record<string, string> = {},
    signal?: AbortSignal,
    assertCurrent?: () => void,
  ) {
    validateDirectoryUrl(url);
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
    let response: Response | undefined;
    let onAbort: (() => void) | undefined;
    try {
      requestSignal.throwIfAborted();
      assertCurrent?.();
      const fetching = this.fetcher(url, {
        signal: requestSignal,
        redirect: "error",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          ...extraHeaders,
        },
      });
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(requestSignal.reason);
        if (requestSignal.aborted) onAbort();
        else requestSignal.addEventListener("abort", onAbort, { once: true });
      });
      // Observe late settlement without adding a promise hop before header admission.
      void fetching.then(value => {
        if (requestSignal.aborted) void value.body?.cancel().catch(() => undefined);
      }, () => undefined);
      response = await Promise.race([fetching, aborted]);

      try {
        signal?.throwIfAborted();
        assertCurrent?.();
      } catch (error) {
        void response.body?.cancel().catch(() => undefined);
        throw error;
      }

      if (!response.ok) {
        const received = response;
        const error = await graphError(received, requestSignal).catch(error => {
          signal?.throwIfAborted();
          // The error-body deadline cannot erase a received HTTP status or Retry-After.
          if (isTimeoutError(error) || requestSignal.aborted) return graphResponseError(received);
          throw error;
        });
        signal?.throwIfAborted();
        assertCurrent?.();
        throw error;
      }

      const result = await boundedProviderJson<T>(response, requestSignal, undefined, parseDirectoryJson);
      requestSignal.throwIfAborted();
      assertCurrent?.();
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      assertCurrent?.();
      if (!response || response.ok) requestSignal.throwIfAborted();
      throw error;
    } finally {
      if (onAbort) requestSignal.removeEventListener("abort", onAbort);
    }
  }
}

function parseDirectoryJson(text: string): unknown {
  const fields = ["id", "displayName", "mail", "userPrincipalName", "description", "groupTypes", "securityEnabled"];
  return parseProviderContractJson(text, {
    root: { fields: ["value", ...fields], arrays: { value: "principal" } },
    principal: { fields },
  }, 3);
}

export function validateDirectoryUrl(url: string) {
  const target = new URL(url);
  if (target.origin !== "https://graph.microsoft.com" || target.username || target.password || !/^\/v1\.0\/(users|groups)(?:\/|$)/.test(target.pathname)) {
    throw new AppError(502, "invalid_provider_link", "Directory request left the documented Microsoft Graph endpoint.");
  }
}

export function buildUserSearchUrl(query: string, limit: number) {
  const url = new URL(`${graphV1}/users`);
  const escaped = escapeSearchTerm(query);
  url.searchParams.set(
    "$search",
    `"displayName:${escaped}" OR "mail:${escaped}" OR "userPrincipalName:${escaped}"`,
  );
  url.searchParams.set("$select", "id,displayName,mail,userPrincipalName");
  url.searchParams.set("$count", "true");
  url.searchParams.set("$top", String(limit));
  return url.toString();
}

export function buildGroupSearchUrl(query: string, limit: number) {
  const url = new URL(`${graphV1}/groups`);
  const escaped = escapeSearchTerm(query);
  url.searchParams.set(
    "$search",
    `"displayName:${escaped}" OR "description:${escaped}"`,
  );
  url.searchParams.set(
    "$select",
    "id,displayName,description,mail,groupTypes,securityEnabled",
  );
  url.searchParams.set("$count", "true");
  url.searchParams.set("$top", String(limit));
  return url.toString();
}

function mapUser(user: GraphUser): DirectoryPrincipal {
  validatePrincipal(user);
  return {
    resourceType: "user",
    resourceId: user.id.toLowerCase(),
    displayName: user.displayName?.trim() || user.userPrincipalName || user.id.toLowerCase(),
    secondaryText: user.mail || user.userPrincipalName || undefined,
    principalKind: "user",
    ...(user.userPrincipalName ? { userPrincipalName: user.userPrincipalName } : {}),
  };
}

function isAssignableGroup(group: GraphGroup) {
  const isMicrosoft365Group = group.groupTypes?.includes("Unified") ?? false;
  return Boolean(group.securityEnabled || isMicrosoft365Group);
}

function mapGroup(group: GraphGroup): DirectoryPrincipal {
  validatePrincipal(group);
  const isMicrosoft365Group = group.groupTypes?.includes("Unified") ?? false;

  return {
    resourceType: "group",
    resourceId: group.id.toLowerCase(),
    displayName: group.displayName?.trim() || group.id.toLowerCase(),
    secondaryText: group.mail || group.description || undefined,
    principalKind: isMicrosoft365Group
      ? "microsoft365Group"
      : group.securityEnabled
        ? "securityGroup"
        : "unknown",
  };
}

function fallbackPrincipal(entity: PackageAccessEntity): DirectoryPrincipal {
  return {
    ...entity,
    displayName: entity.resourceId,
    principalKind: "unknown",
  };
}

function validatePrincipal(value: GraphUser | GraphGroup) {
  if (!value || typeof value.id !== "string" || !isDirectoryObjectId(value.id)) throw new AppError(502, "provider_schema", "Directory principal identity is not a native Microsoft Entra object ID.");
  for (const key of ["displayName", "mail", "userPrincipalName", "description"] as const) {
    const field = (value as Record<string, unknown>)[key];
    if (field !== undefined && field !== null && (typeof field !== "string" || field.length > 4096)) throw new AppError(502, "provider_schema", "Directory principal field is invalid.");
  }
  const group = value as GraphGroup;
  if (group.groupTypes !== undefined && (!Array.isArray(group.groupTypes) || group.groupTypes.length > 20 || group.groupTypes.some(type => typeof type !== "string"))) throw new AppError(502, "provider_schema", "Directory group type is invalid.");
  if (group.securityEnabled !== undefined && group.securityEnabled !== null && typeof group.securityEnabled !== "boolean") throw new AppError(502, "provider_schema", "Directory group security flag is invalid.");
}

function escapeSearchTerm(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function deduplicateEntities(entities: PackageAccessEntity[]) {
  const unique = new Map<string, PackageAccessEntity>();

  for (const entity of entities) {
    if (!entity || typeof entity.resourceId !== "string" || typeof entity.resourceType !== "string"
      || entity.resourceId.length > 128 || entity.resourceType.length > 32
      || /[\u0000-\u001f\u007f-\u009f]/.test(entity.resourceId + entity.resourceType)) {
      throw new AppError(400, "invalid_principal", "Directory principals require bounded text IDs and types without control characters.");
    }
    const resourceId = entity.resourceId.trim().toLowerCase();
    const resourceType = entity.resourceType.trim().toLowerCase();

    if ((resourceType !== "user" && resourceType !== "group") || !isDirectoryObjectId(resourceId)) {
      throw new AppError(400, "invalid_principal", "Directory resolution requires a user or group with a native Microsoft Entra object ID.");
    }

    const key = `${resourceType}:${resourceId}`;
    if (unique.has(key)) throw new AppError(400, "duplicate_principal", "Duplicate directory principals are not allowed.");
    unique.set(key, {
      resourceId,
      resourceType,
    });
  }

  return [...unique.values()];
}

function requireResolvedIdentity(resolvedId: string, requestedId: string) {
  if (resolvedId.toLowerCase() !== requestedId.toLowerCase()) {
    throw new AppError(502, "principal_identity_mismatch", "Microsoft Graph returned a different directory identity than the exact requested object ID.");
  }
}

async function mapWithConcurrency<T, U>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<U>,
) {
  const results = new Array<U>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );

  return results;
}
