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

export type BulkActionResult = {
  targetBlockedState: boolean;
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  results: BulkPackageResult[];
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

export async function blockAgent(id: string) {
  await request<void>(`/api/agents/${encodeURIComponent(id)}/block`, {
    method: "POST",
  });
}

export async function unblockAgent(id: string) {
  await request<void>(`/api/agents/${encodeURIComponent(id)}/unblock`, {
    method: "POST",
  });
}

export async function blockAllAgents() {
  return request<BulkActionResult>("/api/agents/block-all", { method: "POST" });
}

export async function unblockAllAgents() {
  return request<BulkActionResult>("/api/agents/unblock-all", {
    method: "POST",
  });
}

export async function signOut() {
  await request<void>("/auth/logout", { method: "POST" });
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
