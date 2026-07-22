import { Router } from "express";
import type { Request } from "express";
import { randomUUID } from "node:crypto";
import { acquireGraphToken } from "../auth/msal.js";
import { AppError } from "../errors.js";
import { requireSession } from "../middleware/auth.js";
import { getAuditLog } from "../services/auditLog.js";
import {
  completeBulkActionJob,
  createBulkActionJob,
  createBulkAccessJob,
  failBulkActionJob,
  getBulkActionJob,
  recordBulkActionPackageResult,
  startBulkActionPackage,
} from "../services/bulkJobs.js";
import { DirectoryPrincipalsClient } from "../services/directoryPrincipals.js";
import {
  bulkGetPackageDetails,
  bulkSetBlockedState,
  bulkUpdatePackageAccess,
  GraphPackagesClient,
  updatePackageAccess,
} from "../services/graphPackages.js";
import type {
  BulkPackageResult,
  CopilotPackage,
  PackageAccessEntity,
  PackageAccessUpdate,
} from "../types/copilotPackage.js";
import type {
  AccessAuditAction,
  AuditEvent,
  BlockAuditAction,
  CompleteAuditEvent,
} from "../types/audit.js";

export const agentsRouter = Router();
const graphPackages = new GraphPackagesClient();
const directoryPrincipals = new DirectoryPrincipalsClient();
const actionGroupHeader = "x-agent-control-action-group-id";
const detailBatchLimit = 100;
const bulkActionLimit = 5_000;
const principalLimit = 500;

agentsRouter.use(requireSession);

agentsRouter.get("/agents", async (request, response, next) => {
  try {
    const accessToken = await acquireGraphToken(request.session.accountId!);
    const agents = await graphPackages.listCopilotAgents(accessToken);
    response.json({ value: agents });
  } catch (error) {
    next(error);
  }
});

agentsRouter.get("/directory/principals", async (request, response, next) => {
  try {
    const accessToken = await acquireGraphToken(request.session.accountId!);
    const search = firstQueryValue(request.query.search);
    const limitValue = firstQueryValue(request.query.limit);
    const limit = parseDirectorySearchLimit(limitValue);
    const principals = await directoryPrincipals.search(
      accessToken,
      search ?? "",
      limit,
    );
    response.json({ value: principals });
  } catch (error) {
    next(error);
  }
});

agentsRouter.post(
  "/directory/principals/resolve",
  async (request, response, next) => {
    try {
      const accessToken = await acquireGraphToken(request.session.accountId!);
      const principals = parsePackageAccessEntities(
        (request.body as { principals?: unknown })?.principals,
        true,
      );
      const resolved = await directoryPrincipals.resolve(
        accessToken,
        principals,
      );
      response.json({ value: resolved });
    } catch (error) {
      next(error);
    }
  },
);

agentsRouter.post("/agents/details", async (request, response, next) => {
  try {
    const accessToken = await acquireGraphToken(request.session.accountId!);
    const ids = parsePackageDetailIds(request.body);
    const result = await bulkGetPackageDetails(graphPackages, accessToken, ids);
    response.json(result);
  } catch (error) {
    next(error);
  }
});

agentsRouter.get("/agents/:id", async (request, response, next) => {
  try {
    const accessToken = await acquireGraphToken(request.session.accountId!);
    const agent = await graphPackages.getPackageDetails(
      accessToken,
      request.params.id,
    );
    response.json(agent);
  } catch (error) {
    next(error);
  }
});

agentsRouter.get("/agents/bulk-jobs/:id", (request, response, next) => {
  try {
    const job = getBulkActionJob(
      routeParam(request.params.id),
      request.session.accountId!,
    );

    if (!job) {
      throw new AppError(404, "not_found", "Bulk action job was not found.");
    }

    response.json(job);
  } catch (error) {
    next(error);
  }
});

agentsRouter.post("/agents/access", async (request, response, next) => {
  try {
    const accessToken = await acquireGraphToken(request.session.accountId!);
    const ids = parseBulkActionIds(request.body);
    const accessUpdate = parsePackageAccessUpdate(request.body);
    const action = accessAuditAction(accessUpdate.target);
    const job = createBulkAccessJob(
      request.session.accountId!,
      action,
      accessUpdate,
      ids.length,
    );

    runBulkAccessJob(job.id, accessToken, ids, accessUpdate, request, action);
    response.status(202).json(job);
  } catch (error) {
    next(error);
  }
});

agentsRouter.post("/agents/block-all", async (request, response, next) => {
  try {
    const accessToken = await acquireGraphToken(request.session.accountId!);
    const result = await bulkSetBlockedState(graphPackages, accessToken, true, {
      ...createBulkAuditHooks(request, "block", true),
    });
    response.json(result);
  } catch (error) {
    next(error);
  }
});

agentsRouter.post("/agents/block", async (request, response, next) => {
  try {
    const accessToken = await acquireGraphToken(request.session.accountId!);
    const ids = parseBulkActionIds(request.body);
    const job = createBulkActionJob(
      request.session.accountId!,
      "block",
      true,
      ids.length,
    );

    runBulkActionJob(job.id, accessToken, true, ids, request, "block");
    response.status(202).json(job);
  } catch (error) {
    next(error);
  }
});

agentsRouter.post("/agents/unblock-all", async (request, response, next) => {
  try {
    const accessToken = await acquireGraphToken(request.session.accountId!);
    const result = await bulkSetBlockedState(
      graphPackages,
      accessToken,
      false,
      {
        ...createBulkAuditHooks(request, "unblock", false),
      },
    );
    response.json(result);
  } catch (error) {
    next(error);
  }
});

agentsRouter.post("/agents/unblock", async (request, response, next) => {
  try {
    const accessToken = await acquireGraphToken(request.session.accountId!);
    const ids = parseBulkActionIds(request.body);
    const job = createBulkActionJob(
      request.session.accountId!,
      "unblock",
      false,
      ids.length,
    );

    runBulkActionJob(job.id, accessToken, false, ids, request, "unblock");
    response.status(202).json(job);
  } catch (error) {
    next(error);
  }
});

agentsRouter.post("/agents/:id/block", async (request, response, next) => {
  try {
    const accessToken = await acquireGraphToken(request.session.accountId!);
    const agentId = routeParam(request.params.id);
    const agentDisplayName = await resolveAgentDisplayName(
      accessToken,
      agentId,
    );

    await runAuditedAgentAction(
      request,
      "block",
      true,
      agentId,
      agentDisplayName,
      () => graphPackages.blockPackage(accessToken, agentId),
    );
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

agentsRouter.post("/agents/:id/unblock", async (request, response, next) => {
  try {
    const accessToken = await acquireGraphToken(request.session.accountId!);
    const agentId = routeParam(request.params.id);
    const agentDisplayName = await resolveAgentDisplayName(
      accessToken,
      agentId,
    );

    await runAuditedAgentAction(
      request,
      "unblock",
      false,
      agentId,
      agentDisplayName,
      () => graphPackages.unblockPackage(accessToken, agentId),
    );
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

agentsRouter.patch("/agents/:id/access", async (request, response, next) => {
  try {
    const accessToken = await acquireGraphToken(request.session.accountId!);
    const agentId = routeParam(request.params.id);
    const accessUpdate = parsePackageAccessUpdate(request.body);

    if (accessUpdate.mode !== "replace") {
      throw new AppError(
        400,
        "invalid_access_update",
        "Single-agent access updates use replace mode.",
      );
    }

    const current = await graphPackages.getPackageDetails(accessToken, agentId);
    const action = accessAuditAction(accessUpdate.target);
    const result = await runAuditedAccessAction(
      request,
      action,
      agentId,
      current.displayName,
      accessUpdate,
      () =>
        updatePackageAccess(graphPackages, accessToken, agentId, accessUpdate),
    );
    const agent = await graphPackages.getPackageDetails(accessToken, agentId);
    response.json({ agent, result });
  } catch (error) {
    next(error);
  }
});

async function runAuditedAgentAction(
  request: Request,
  action: BlockAuditAction,
  targetBlockedState: boolean,
  agentId: string,
  agentDisplayName: string | undefined,
  runAction: () => Promise<void>,
) {
  const auditEvent = startAuditEvent(
    request,
    { action, targetBlockedState },
    agentId,
    agentDisplayName,
  );

  try {
    await runAction();
    completeAuditEvent(auditEvent, { status: "succeeded" });
  } catch (error) {
    completeAuditEvent(auditEvent, {
      status: "failed",
      message: error instanceof Error ? error.message : "Unknown error",
      errorCode: error instanceof AppError ? error.code : undefined,
      metadata:
        error instanceof AppError && error.details !== undefined
          ? { errorDetails: error.details }
          : undefined,
    });
    throw error;
  }
}

async function runAuditedAccessAction(
  request: Request,
  action: AccessAuditAction,
  agentId: string,
  agentDisplayName: string | undefined,
  accessUpdate: PackageAccessUpdate,
  runAction: () => ReturnType<typeof updatePackageAccess>,
) {
  const auditEvent = startAuditEvent(
    request,
    { action },
    agentId,
    agentDisplayName,
    accessAuditMetadata(accessUpdate),
  );

  try {
    const result = await runAction();
    completeAuditEvent(auditEvent, {
      status: result.changed ? "succeeded" : "skipped",
      message: result.changed ? undefined : "Access already assigned",
      metadata: {
        ...accessAuditMetadata(accessUpdate),
        previousCount: result.previousCount,
        resultingCount: result.resultingCount,
      },
    });
    return result;
  } catch (error) {
    completeAuditEvent(auditEvent, {
      status: "failed",
      message: error instanceof Error ? error.message : "Unknown error",
      errorCode: error instanceof AppError ? error.code : undefined,
      metadata: {
        ...accessAuditMetadata(accessUpdate),
        ...(error instanceof AppError && error.details !== undefined
          ? { errorDetails: error.details }
          : {}),
      },
    });
    throw error;
  }
}

function startAuditEvent(
  request: Request,
  actionDetails:
    | { action: BlockAuditAction; targetBlockedState: boolean }
    | { action: AccessAuditAction; targetBlockedState?: never },
  agentId: string,
  agentDisplayName: string | undefined,
  metadata?: Record<string, unknown>,
) {
  const auditLog = getAuditLog();
  const operationContext = getAuditOperationContext(request);

  return auditLog?.startEvent({
    operationId: operationContext.operationId,
    scope: operationContext.scope,
    ...actionDetails,
    agentId,
    agentDisplayName,
    actor: request.session.user!,
    requestPath: request.originalUrl,
    metadata,
  });
}

async function resolveAgentDisplayName(accessToken: string, agentId: string) {
  try {
    const agent = await graphPackages.getPackageDetails(accessToken, agentId);
    return agent.displayName;
  } catch (error) {
    console.warn("Failed to resolve audit agent display name", error);
    return undefined;
  }
}

function getAuditOperationContext(request: Request) {
  const actionGroupId = parseActionGroupId(request.get(actionGroupHeader));

  if (actionGroupId) {
    return { operationId: actionGroupId, scope: "bulk" as const };
  }

  return { operationId: randomUUID(), scope: "single" as const };
}

export function parseActionGroupId(value: string | undefined) {
  const normalized = value?.trim();

  if (!normalized) {
    return undefined;
  }

  if (normalized.length > 64 || !/^[a-zA-Z0-9-]+$/.test(normalized)) {
    throw new AppError(
      400,
      "invalid_action_group_id",
      "Action group ID is invalid.",
    );
  }

  return normalized;
}

function routeParam(value: string | string[]) {
  return Array.isArray(value) ? value[0] : value;
}

function firstQueryValue(value: unknown) {
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : undefined;
  }

  return typeof value === "string" ? value : undefined;
}

export function parseDirectorySearchLimit(value: string | undefined) {
  if (value === undefined) {
    return undefined;
  }

  if (!/^\d+$/.test(value)) {
    throw new AppError(
      400,
      "invalid_directory_limit",
      "Directory search limit must be a positive integer.",
    );
  }

  const limit = Number.parseInt(value, 10);

  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new AppError(
      400,
      "invalid_directory_limit",
      "Directory search limit must be a positive integer.",
    );
  }

  return limit;
}

export function parsePackageAccessUpdate(body: unknown): PackageAccessUpdate {
  const candidate = body as {
    target?: unknown;
    mode?: unknown;
    scope?: unknown;
    principals?: unknown;
  };
  const target = candidate?.target;
  const mode = candidate?.mode;
  const scope = candidate?.scope;

  if (target !== "availability" && target !== "installation") {
    throw new AppError(
      400,
      "invalid_access_target",
      "Access target must be availability or installation.",
    );
  }

  if (mode !== "add" && mode !== "replace") {
    throw new AppError(
      400,
      "invalid_access_mode",
      "Access mode must be add or replace.",
    );
  }

  if (scope === "all") {
    throw new AppError(
      400,
      "all_users_unverified",
      "The Microsoft Graph payload for All users has not been verified for this tenant.",
    );
  }

  if (scope !== "specific" && scope !== "none") {
    throw new AppError(
      400,
      "invalid_access_scope",
      "Access scope must be specific or none.",
    );
  }

  const principals = parsePackageAccessEntities(candidate.principals);

  if (scope === "none" && (mode !== "replace" || principals.length > 0)) {
    throw new AppError(
      400,
      "invalid_access_update",
      "No users requires replace mode and no principals.",
    );
  }

  if (scope === "none") {
    return { target, mode: "replace", scope, principals: [] };
  }

  if (principals.length === 0) {
    throw new AppError(
      400,
      "invalid_access_update",
      "At least one principal is required for specific access.",
    );
  }

  return { target, mode, scope: "specific", principals };
}

function parsePackageAccessEntities(value: unknown, requireAtLeastOne = false) {
  if (value === undefined && !requireAtLeastOne) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new AppError(
      400,
      "invalid_principals",
      "Expected principals to be an array.",
    );
  }

  if (value.length > principalLimit) {
    throw new AppError(
      400,
      "too_many_principals",
      `A maximum of ${principalLimit} principals can be submitted at once.`,
    );
  }

  const unique = new Map<string, PackageAccessEntity>();

  for (const item of value) {
    const entity = item as { resourceType?: unknown; resourceId?: unknown };
    const resourceType = entity?.resourceType;
    const resourceId =
      typeof entity?.resourceId === "string" ? entity.resourceId.trim() : "";

    if ((resourceType !== "user" && resourceType !== "group") || !resourceId) {
      throw new AppError(
        400,
        "invalid_principal",
        "Each principal requires a user or group resourceType and resourceId.",
      );
    }

    unique.set(`${resourceType}:${resourceId.toLowerCase()}`, {
      resourceType,
      resourceId,
    });
  }

  if (requireAtLeastOne && unique.size === 0) {
    throw new AppError(
      400,
      "invalid_principals",
      "At least one principal is required.",
    );
  }

  return [...unique.values()];
}

function parsePackageDetailIds(body: unknown) {
  const ids = (body as { ids?: unknown })?.ids;

  if (!Array.isArray(ids)) {
    throw new AppError(400, "invalid_request", "Expected ids to be an array.");
  }

  const uniqueIds = parsePackageIds(ids, detailBatchLimit);

  if (uniqueIds.length === 0) {
    throw new AppError(400, "invalid_request", "At least one id is required.");
  }

  if (uniqueIds.length > detailBatchLimit) {
    throw new AppError(
      400,
      "invalid_request",
      `A maximum of ${detailBatchLimit} ids can be requested at once.`,
    );
  }

  return uniqueIds;
}

export function parseBulkActionIds(body: unknown) {
  const ids = (body as { ids?: unknown })?.ids;

  if (!Array.isArray(ids)) {
    throw new AppError(400, "invalid_request", "Expected ids to be an array.");
  }

  const uniqueIds = parsePackageIds(ids, bulkActionLimit);

  if (uniqueIds.length === 0) {
    throw new AppError(400, "invalid_request", "At least one id is required.");
  }

  if (uniqueIds.length > bulkActionLimit) {
    throw new AppError(
      400,
      "invalid_request",
      `A maximum of ${bulkActionLimit} ids can be requested at once.`,
    );
  }

  return uniqueIds;
}

function parsePackageIds(ids: unknown[], limit: number) {
  const uniqueIds = new Set<string>();

  for (const id of ids) {
    if (typeof id !== "string" || !id.trim()) {
      throw new AppError(
        400,
        "invalid_request",
        "Each id must be a non-empty string.",
      );
    }

    uniqueIds.add(id.trim());
    if (uniqueIds.size > limit) {
      break;
    }
  }

  return [...uniqueIds];
}

function runBulkActionJob(
  jobId: string,
  accessToken: string,
  targetBlockedState: boolean,
  packageIds: string[],
  request: Request,
  action: BlockAuditAction,
) {
  const auditHooks = createBulkAuditHooks(
    request,
    action,
    targetBlockedState,
    jobId,
  );

  void bulkSetBlockedState(graphPackages, accessToken, targetBlockedState, {
    packageIds,
    onPackageStart: async (agent) => {
      startBulkActionPackage(jobId, agent.displayName);
      await auditHooks.onPackageStart(agent);
    },
    onPackageResult: async (result) => {
      recordBulkActionPackageResult(jobId, result);
      await auditHooks.onPackageResult(result);
    },
  })
    .then((result) => {
      completeBulkActionJob(jobId, result);
    })
    .catch((error: unknown) => {
      failBulkActionJob(jobId, error);
    });
}

function runBulkAccessJob(
  jobId: string,
  accessToken: string,
  packageIds: string[],
  accessUpdate: PackageAccessUpdate,
  request: Request,
  action: AccessAuditAction,
) {
  const auditHooks = createBulkAccessAuditHooks(
    request,
    action,
    accessUpdate,
    jobId,
  );

  void bulkUpdatePackageAccess(graphPackages, accessToken, accessUpdate, {
    packageIds,
    onPackageStart: async (agent) => {
      startBulkActionPackage(jobId, agent.displayName);
      await auditHooks.onPackageStart(agent);
    },
    onPackageResult: async (result) => {
      recordBulkActionPackageResult(jobId, result);
      await auditHooks.onPackageResult(result);
    },
  })
    .then((result) => completeBulkActionJob(jobId, result))
    .catch((error: unknown) => failBulkActionJob(jobId, error));
}

function completeAuditEvent(
  auditEvent: AuditEvent | undefined,
  update: CompleteAuditEvent,
) {
  if (!auditEvent) {
    return;
  }

  try {
    getAuditLog()?.completeEvent(auditEvent.id, update);
  } catch (error) {
    console.error("Failed to update audit event", error);
  }
}

function createBulkAuditHooks(
  request: Request,
  action: BlockAuditAction,
  targetBlockedState: boolean,
  operationId: string = randomUUID(),
) {
  const auditLog = getAuditLog();
  const auditEvents = new Map<string, AuditEvent>();

  function ensureAuditEvent(agentId: string, agentDisplayName: string) {
    const existing = auditEvents.get(agentId);

    if (existing || !auditLog) {
      return existing;
    }

    const auditEvent = auditLog.startEvent({
      operationId,
      scope: "bulk",
      action,
      targetBlockedState,
      agentId,
      agentDisplayName,
      actor: request.session.user!,
      requestPath: request.originalUrl,
    });
    auditEvents.set(agentId, auditEvent);
    return auditEvent;
  }

  return {
    onPackageStart(agent: CopilotPackage) {
      ensureAuditEvent(agent.id, agent.displayName);
    },
    onPackageResult(result: BulkPackageResult) {
      completeAuditEvent(ensureAuditEvent(result.id, result.displayName), {
        status: result.status,
        message: result.message,
        errorCode: result.errorCode,
        metadata:
          result.errorDetails !== undefined
            ? { errorDetails: result.errorDetails }
            : undefined,
      });
    },
  };
}

function createBulkAccessAuditHooks(
  request: Request,
  action: AccessAuditAction,
  accessUpdate: PackageAccessUpdate,
  operationId: string,
) {
  const auditLog = getAuditLog();
  const auditEvents = new Map<string, AuditEvent>();

  function ensureAuditEvent(agentId: string, agentDisplayName: string) {
    const existing = auditEvents.get(agentId);

    if (existing || !auditLog) {
      return existing;
    }

    const auditEvent = auditLog.startEvent({
      operationId,
      scope: "bulk",
      action,
      agentId,
      agentDisplayName,
      actor: request.session.user!,
      requestPath: request.originalUrl,
      metadata: accessAuditMetadata(accessUpdate),
    });
    auditEvents.set(agentId, auditEvent);
    return auditEvent;
  }

  return {
    onPackageStart(agent: CopilotPackage) {
      ensureAuditEvent(agent.id, agent.displayName);
    },
    onPackageResult(result: BulkPackageResult) {
      completeAuditEvent(ensureAuditEvent(result.id, result.displayName), {
        status: result.status,
        message: result.message,
        errorCode: result.errorCode,
        metadata: {
          ...accessAuditMetadata(accessUpdate),
          ...(result.accessResult
            ? {
                previousCount: result.accessResult.previousCount,
                resultingCount: result.accessResult.resultingCount,
              }
            : {}),
          ...(result.errorDetails !== undefined
            ? { errorDetails: result.errorDetails }
            : {}),
        },
      });
    },
  };
}

function accessAuditAction(target: PackageAccessUpdate["target"]) {
  return target === "availability"
    ? ("update-availability" as const)
    : ("update-installation" as const);
}

function accessAuditMetadata(accessUpdate: PackageAccessUpdate) {
  return {
    target: accessUpdate.target,
    mode: accessUpdate.mode,
    scope: accessUpdate.scope,
    principals: accessUpdate.principals,
  };
}
