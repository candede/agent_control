import { AppError } from "../errors.js";
import type { PackageAccessEntity } from "../types/copilotPackage.js";
import { graphError, type FetchLike } from "./graphPackages.js";

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
};

export class DirectoryPrincipalsClient {
  constructor(private readonly fetcher: FetchLike = fetch) {}

  async search(accessToken: string, query: string, limit = defaultSearchLimit) {
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
      ),
      this.request<GraphCollection<GraphGroup>>(
        buildGroupSearchUrl(normalizedQuery, normalizedLimit),
        accessToken,
        { ConsistencyLevel: "eventual" },
      ),
    ]);

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
  ) {
    const response = await this.fetcher(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        ...extraHeaders,
      },
    });

    if (!response.ok) {
      throw await graphError(response);
    }

    return (await response.json()) as T;
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

function escapeSearchTerm(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function deduplicateEntities(entities: PackageAccessEntity[]) {
  const unique = new Map<string, PackageAccessEntity>();

  for (const entity of entities) {
    const resourceId = entity.resourceId.trim();
    const resourceType = entity.resourceType.trim();

    if (!resourceId || !resourceType) {
      continue;
    }

    unique.set(`${resourceType.toLowerCase()}:${resourceId.toLowerCase()}`, {
      resourceId,
      resourceType,
    });
  }

  return [...unique.values()];
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
