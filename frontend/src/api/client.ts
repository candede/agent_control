export type SessionUser = {
  displayName: string;
  username: string;
  homeAccountId: string;
  tenantId?: string;
};

export type CopilotPackage = {
  id: string;
  displayName: string;
  type?: string;
  shortDescription?: string;
  isBlocked: boolean;
  supportedHosts?: string[];
  lastModifiedDateTime?: string;
  publisher?: string;
  availableTo?: string;
  deployedTo?: string;
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
};

export type BulkSideEffectError = {
  phase: "start" | "result";
  agentId: string;
  message: string;
};

export type BulkActionResult = {
  targetBlockedState: boolean;
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  results: BulkPackageResult[];
  sideEffectErrors?: BulkSideEffectError[];
};

export type BulkJobStatus = "queued" | "running" | "completed" | "failed";

export type BulkActionJob = {
  id: string;
  action: AuditAction;
  targetBlockedState: boolean;
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

export type AuditAction = "block" | "unblock";

export type AuditScope = "single" | "bulk";

export type AuditStatus = "started" | "succeeded" | "failed" | "skipped";

export type AuditEvent = {
  id: string;
  operationId: string;
  scope: AuditScope;
  action: AuditAction;
  targetBlockedState: boolean;
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

export type AuditEventsQuery = {
  limit?: number;
  agentId?: string;
  actorUsername?: string;
  scope?: AuditScope;
  action?: AuditAction;
  status?: AuditStatus;
  operationIdPrefix?: string;
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

  const queryString = searchParams.toString();
  return request<{ value: AuditEvent[] }>(
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
