import { AppError } from "../errors.js";
import type { PackageAccessEntity } from "../types/copilotPackage.js";
import { graphError, type FetchLike } from "./graphPackages.js";
import { boundedProviderJson } from "./providerJson.js";

const graphV1 = "https://graph.microsoft.com/v1.0";
const defaultSearchLimit = 25;
const maxSearchLimit = 50;
const maxSearchQueryLength = 120;
const maxResolveCount = 500;
const resolveConcurrency = 8;
const directoryObjectIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

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
};

export class DirectoryPrincipalsClient {
  constructor(private readonly fetcher: FetchLike = fetch) {}

  async search(accessToken: string, query: string, limit = defaultSearchLimit, signal?: AbortSignal) {
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
    const [users, groups] = await Promise.all([
      this.request<GraphCollection<GraphUser>>(
        buildUserSearchUrl(normalizedQuery, normalizedLimit),
        accessToken,
        { ConsistencyLevel: "eventual" },
        signal,
      ),
      this.request<GraphCollection<GraphGroup>>(
        buildGroupSearchUrl(normalizedQuery, normalizedLimit),
        accessToken,
        { ConsistencyLevel: "eventual" },
        signal,
      ),
    ]);

    if (!Array.isArray(users.value) || !Array.isArray(groups.value) || users.value.length > maxSearchLimit || groups.value.length > maxSearchLimit) {
      throw new AppError(502, "provider_schema", "Directory collection is invalid or oversized.");
    }
    [...users.value, ...groups.value].forEach(validatePrincipal);

    return [
      ...users.value.map(mapUser),
      ...groups.value.filter(isAssignableGroup).map(mapGroup),
    ]
      .sort((left, right) =>
        left.displayName.localeCompare(right.displayName, undefined, {
          sensitivity: "base",
        }),
      )
      .slice(0, normalizedLimit);
  }

  async resolve(accessToken: string, entities: PackageAccessEntity[]) {
    const unique = deduplicateEntities(entities);

    if (unique.length > maxResolveCount) {
      throw new AppError(
        400,
        "too_many_principals",
        `A maximum of ${maxResolveCount} principals can be resolved at once.`,
      );
    }

    return mapWithConcurrency(
      unique,
      resolveConcurrency,
      async (entity): Promise<DirectoryPrincipal> => {
        if (entity.resourceType === "user") {
          return this.resolveUser(accessToken, entity.resourceId);
        }

        if (entity.resourceType === "group") {
          return this.resolveGroup(accessToken, entity.resourceId);
        }

        return fallbackPrincipal(entity);
      },
    );
  }

  private async resolveUser(accessToken: string, id: string) {
    try {
      const user = await this.request<GraphUser>(
        `${graphV1}/users/${encodeURIComponent(id)}?$select=id,displayName,mail,userPrincipalName`,
        accessToken,
      );
      requireResolvedIdentity(user.id, id);
      return mapUser(user);
    } catch (error) {
      if (error instanceof AppError && error.status === 404) {
        return fallbackPrincipal({ resourceType: "user", resourceId: id });
      }
      throw error;
    }
  }

  private async resolveGroup(accessToken: string, id: string) {
    try {
      const group = await this.request<GraphGroup>(
        `${graphV1}/groups/${encodeURIComponent(id)}?$select=id,displayName,description,mail,groupTypes,securityEnabled`,
        accessToken,
      );
      requireResolvedIdentity(group.id, id);
      return mapGroup(group);
    } catch (error) {
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
  ) {
    validateDirectoryUrl(url);
    const response = await this.fetcher(url, {
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      redirect: "error",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        ...extraHeaders,
      },
    });

    if (!response.ok) {
      throw await graphError(response);
    }

    return boundedProviderJson<T>(response);
  }
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
    resourceId: user.id,
    displayName: user.displayName?.trim() || user.userPrincipalName || user.id,
    secondaryText: user.mail || user.userPrincipalName || undefined,
    principalKind: "user",
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
    resourceId: group.id,
    displayName: group.displayName?.trim() || group.id,
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
  if (!value || typeof value.id !== "string" || !directoryObjectIdPattern.test(value.id)) throw new AppError(502, "provider_schema", "Directory principal identity is not a native Microsoft Entra object ID.");
  for (const key of ["displayName", "mail", "userPrincipalName", "description"] as const) {
    const field = (value as Record<string, unknown>)[key];
    if (field !== undefined && field !== null && (typeof field !== "string" || field.length > 4096)) throw new AppError(502, "provider_schema", "Directory principal field is invalid.");
  }
  const group = value as GraphGroup;
  if (group.groupTypes !== undefined && (!Array.isArray(group.groupTypes) || group.groupTypes.length > 20 || group.groupTypes.some(type => typeof type !== "string"))) throw new AppError(502, "provider_schema", "Directory group type is invalid.");
}

function escapeSearchTerm(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function deduplicateEntities(entities: PackageAccessEntity[]) {
  const unique = new Map<string, PackageAccessEntity>();

  for (const entity of entities) {
    const resourceId = entity.resourceId.trim();
    const resourceType = entity.resourceType.trim().toLowerCase();

    if ((resourceType !== "user" && resourceType !== "group") || !directoryObjectIdPattern.test(resourceId)) {
      throw new AppError(400, "invalid_principal", "Directory resolution requires a user or group with a native Microsoft Entra object ID.");
    }

    const key = `${resourceType}:${resourceId.toLowerCase()}`;
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
