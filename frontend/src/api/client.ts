export type SessionUser = {
  displayName: string;
  username: string;
  homeAccountId: string;
  tenantId?: string;
};

export type PackageStatus =
  | "all"
  | "some"
  | "none"
  | "allowedForAll"
  | "allowedForSome"
  | "allowedForNoOne"
  | "unknownFutureValue";

export type CopilotPackage = {
  id: string;
  displayName: string;
  type?: string;
  shortDescription?: string;
  isBlocked: boolean;
  supportedHosts?: string[];
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  publisher?: string;
  availableTo?: PackageStatus;
  deployedTo?: PackageStatus;
  elementTypes?: string[];
  platform?: string;
  version?: string;
  manifestVersion?: string;
  manifestId?: string;
  appId?: string;
  assetId?: string;
};

export type PackageAccessEntity = {
  resourceId: string;
  resourceType: "user" | "group" | string;
};

export type PackageAccessTarget = "availability" | "installation";
export type PackageAccessMutationMode = "add" | "replace";
export type PackageAccessScope = "specific" | "none";

export type PackageAccessUpdate =
  | {
      target: PackageAccessTarget;
      mode: "add";
      scope: "specific";
      principals: PackageAccessEntity[];
    }
  | {
      target: PackageAccessTarget;
      mode: "replace";
      scope: "specific";
      principals: PackageAccessEntity[];
    }
  | {
      target: PackageAccessTarget;
      mode: "replace";
      scope: "none";
      principals: never[];
    };

export type PackageAccessReplacement = Extract<
  PackageAccessUpdate,
  { mode: "replace" }
>;

export type PackageAccessUpdateResult = {
  changed: boolean;
  previousCount: number;
  resultingCount: number;
  principals: PackageAccessEntity[];
};

export type DirectoryPrincipal = PackageAccessEntity & {
  displayName: string;
  secondaryText?: string;
  principalKind: "user" | "securityGroup" | "microsoft365Group" | "unknown";
};

export type PackageElementDetail = {
  elementType: string;
  elements: Array<{
    id: string;
    definition: string;
  }>;
};

export type CopilotPackageDetail = CopilotPackage & {
  longDescription?: string;
  categories?: string[];
  sensitivity?: string;
  allowedUsersAndGroups?: PackageAccessEntity[];
  acquireUsersAndGroups?: PackageAccessEntity[];
  elementDetails?: PackageElementDetail[];
};

export type BulkPackageResult = {
  id: string;
  displayName: string;
  status: "succeeded" | "failed" | "skipped";
  message?: string;
  errorCode?: string;
  errorDetails?: unknown;
  accessResult?: PackageAccessUpdateResult;
};

export type BulkSideEffectError = {
  phase: "start" | "result";
  agentId: string;
  message: string;
};

type BulkActionResultBase = {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  results: BulkPackageResult[];
  sideEffectErrors?: BulkSideEffectError[];
};

export type BulkActionResult = BulkActionResultBase &
  (
    | { targetBlockedState: boolean; accessUpdate?: never }
    | { targetBlockedState?: never; accessUpdate: PackageAccessUpdate }
  );

export type BulkJobStatus = "queued" | "running" | "completed" | "failed";

type BulkActionJobBase = {
  id: string;
  status: BulkJobStatus;
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  results: BulkPackageResult[];
  result?: BulkActionResult;
  currentAgentName?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type BulkActionJob = BulkActionJobBase &
  (
    | {
        action: BlockAuditAction;
        targetBlockedState: boolean;
        accessUpdate?: never;
      }
    | {
        action: AccessAuditAction;
        targetBlockedState?: never;
        accessUpdate: PackageAccessUpdate;
      }
  );

export type BulkPackageDetailResult =
  | {
      id: string;
      status: "succeeded";
      package: CopilotPackageDetail;
    }
  | {
      id: string;
      status: "failed";
      message: string;
    };

export type BulkPackageDetailsResult = {
  total: number;
  succeeded: number;
  failed: number;
  results: BulkPackageDetailResult[];
};

export type BlockAuditAction = "block" | "unblock";
export type AccessAuditAction = "update-availability" | "update-installation";
export type AuditAction = BlockAuditAction | AccessAuditAction;

export type AuditScope = "single" | "bulk";

export type AuditStatus = "started" | "succeeded" | "failed" | "skipped";

type AuditEventBase = {
  id: string;
  operationId: string;
  scope: AuditScope;
  agentId: string;
  agentDisplayName?: string;
  actor: SessionUser;
  startedAt: string;
  completedAt?: string;
  status: AuditStatus;
  message?: string;
  errorCode?: string;
  requestPath: string;
  metadata?: Record<string, unknown>;
};

export type AuditEvent = AuditEventBase &
  (
    | { action: BlockAuditAction; targetBlockedState: boolean }
    | { action: AccessAuditAction; targetBlockedState?: never }
  );

export type AuditEventsQuery = {
  limit?: number;
  offset?: number;
  agentId?: string;
  actorUsername?: string;
  scope?: AuditScope;
  action?: AuditAction;
  status?: AuditStatus;
  operationIdPrefix?: string;
  search?: string;
};

export type AuditEventsResponse = {
  value: AuditEvent[];
  count: number;
};

export type AuditRequestContext = {
  actionGroupId?: string;
};

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function getCurrentUser() {
  return request<{ user: SessionUser }>("/api/me");
}

export async function getAgents() {
  return request<{ value: CopilotPackage[] }>("/api/agents");
}

export async function getAgentDetails(id: string) {
  return request<CopilotPackageDetail>(`/api/agents/${encodeURIComponent(id)}`);
}

export async function getAgentDetailsBatch(ids: string[]) {
  return request<BulkPackageDetailsResult>("/api/agents/details", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
}

export async function searchDirectoryPrincipals(search: string, limit = 25) {
  const params = new URLSearchParams({ search, limit: String(limit) });
  return request<{ value: DirectoryPrincipal[] }>(
    `/api/directory/principals?${params.toString()}`,
  );
}

export async function resolveDirectoryPrincipals(
  principals: PackageAccessEntity[],
) {
  return request<{ value: DirectoryPrincipal[] }>(
    "/api/directory/principals/resolve",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ principals }),
    },
  );
}

export async function updateAgentAccess(
  id: string,
  update: PackageAccessReplacement,
) {
  return request<{
    agent: CopilotPackageDetail;
    result: PackageAccessUpdateResult;
  }>(`/api/agents/${encodeURIComponent(id)}/access`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
}

export async function updateAgentsAccess(
  ids: string[],
  update: PackageAccessUpdate,
) {
  return request<BulkActionJob>("/api/agents/access", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, ...update }),
  });
}

export async function blockAgent(id: string, context?: AuditRequestContext) {
  await request<void>(`/api/agents/${encodeURIComponent(id)}/block`, {
    method: "POST",
    headers: auditContextHeaders(context),
  });
}

export async function unblockAgent(id: string, context?: AuditRequestContext) {
  await request<void>(`/api/agents/${encodeURIComponent(id)}/unblock`, {
    method: "POST",
    headers: auditContextHeaders(context),
  });
}

export async function blockAgents(ids: string[]) {
  return request<BulkActionJob>("/api/agents/block", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
}

export async function unblockAgents(ids: string[]) {
  return request<BulkActionJob>("/api/agents/unblock", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
}

export async function getBulkActionJob(id: string) {
  return request<BulkActionJob>(
    `/api/agents/bulk-jobs/${encodeURIComponent(id)}`,
  );
}

export async function blockAllAgents() {
  return request<BulkActionResult>("/api/agents/block-all", { method: "POST" });
}

export async function unblockAllAgents() {
  return request<BulkActionResult>("/api/agents/unblock-all", {
    method: "POST",
  });
}

export async function getAuditEvents(query: AuditEventsQuery = {}) {
  const searchParams = new URLSearchParams();

  if (query.limit) {
    searchParams.set("limit", query.limit.toString());
  }

  if (query.offset !== undefined) {
    searchParams.set("offset", query.offset.toString());
  }

  if (query.agentId) {
    searchParams.set("agentId", query.agentId);
  }

  if (query.actorUsername) {
    searchParams.set("actorUsername", query.actorUsername);
  }

  if (query.scope) {
    searchParams.set("scope", query.scope);
  }

  if (query.action) {
    searchParams.set("action", query.action);
  }

  if (query.status) {
    searchParams.set("status", query.status);
  }

  if (query.operationIdPrefix) {
    searchParams.set("operationIdPrefix", query.operationIdPrefix);
  }

  if (query.search) {
    searchParams.set("search", query.search);
  }

  const queryString = searchParams.toString();
  return request<AuditEventsResponse>(
    `/api/audit/events${queryString ? `?${queryString}` : ""}`,
  );
}

export async function signOut() {
  await request<void>("/api/auth/logout", { method: "POST" });
}

function auditContextHeaders(context: AuditRequestContext | undefined) {
  return context?.actionGroupId
    ? { "x-agent-control-action-group-id": context.actionGroupId }
    : undefined;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...init.headers,
    },
  });

  if (!response.ok) {
    throw await toApiError(response);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

async function toApiError(response: Response) {
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string };
    };

    return new ApiError(
      response.status,
      body.error?.code ?? "request_failed",
      body.error?.message ?? `Request failed with status ${response.status}.`,
    );
  } catch {
    return new ApiError(
      response.status,
      "request_failed",
      `Request failed with status ${response.status}.`,
    );
  }
}
