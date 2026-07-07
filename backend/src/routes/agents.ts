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
  failBulkActionJob,
  getBulkActionJob,
  recordBulkActionPackageResult,
  startBulkActionPackage,
} from "../services/bulkJobs.js";
import {
  bulkGetPackageDetails,
  bulkSetBlockedState,
  GraphPackagesClient,
} from "../services/graphPackages.js";
import type {
  BulkPackageResult,
  CopilotPackage,
} from "../types/copilotPackage.js";
import type {
  AuditAction,
  AuditEvent,
  CompleteAuditEvent,
} from "../types/audit.js";

export const agentsRouter = Router();
const graphPackages = new GraphPackagesClient();
const actionGroupHeader = "x-agent-control-action-group-id";
const detailBatchLimit = 100;
const bulkActionLimit = 5_000;

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
    const job = getBulkActionJob(routeParam(request.params.id));

    if (!job) {
      throw new AppError(404, "not_found", "Bulk action job was not found.");
    }

    response.json(job);
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
    const job = createBulkActionJob("block", true, ids.length);

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
    const job = createBulkActionJob("unblock", false, ids.length);

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

async function runAuditedAgentAction(
  request: Request,
  action: AuditAction,
  targetBlockedState: boolean,
  agentId: string,
  agentDisplayName: string | undefined,
  runAction: () => Promise<void>,
) {
  const auditEvent = startAuditEvent(
    request,
    action,
    targetBlockedState,
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

function startAuditEvent(
  request: Request,
  action: AuditAction,
  targetBlockedState: boolean,
  agentId: string,
  agentDisplayName: string | undefined,
) {
  const auditLog = getAuditLog();
  const operationContext = getAuditOperationContext(request);

  return auditLog?.startEvent({
    operationId: operationContext.operationId,
    scope: operationContext.scope,
    action,
    targetBlockedState,
    agentId,
    agentDisplayName,
    actor: request.session.user!,
    requestPath: request.originalUrl,
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
  const actionGroupId = routeParam(request.get(actionGroupHeader) ?? "").trim();

  if (actionGroupId) {
    return { operationId: actionGroupId, scope: "bulk" as const };
  }

  return { operationId: randomUUID(), scope: "single" as const };
}

function routeParam(value: string | string[]) {
  return Array.isArray(value) ? value[0] : value;
}

function parsePackageDetailIds(body: unknown) {
  const ids = (body as { ids?: unknown })?.ids;

  if (!Array.isArray(ids)) {
    throw new AppError(400, "invalid_request", "Expected ids to be an array.");
  }

  const uniqueIds = [...new Set(ids.map((id) => routeParam(String(id)).trim()))]
    .filter(Boolean)
    .slice(0, detailBatchLimit + 1);

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

function parseBulkActionIds(body: unknown) {
  const ids = (body as { ids?: unknown })?.ids;

  if (!Array.isArray(ids)) {
    throw new AppError(400, "invalid_request", "Expected ids to be an array.");
  }

  const uniqueIds = [...new Set(ids.map((id) => routeParam(String(id)).trim()))]
    .filter(Boolean)
    .slice(0, bulkActionLimit + 1);

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

function runBulkActionJob(
  jobId: string,
  accessToken: string,
  targetBlockedState: boolean,
  packageIds: string[],
  request: Request,
  action: AuditAction,
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
  action: AuditAction,
  targetBlockedState: boolean,
  operationId: string = randomUUID(),
) {
  const auditLog = getAuditLog();
  const auditEvents = new Map<string, AuditEvent>();

  return {
    onPackageStart(agent: CopilotPackage) {
      if (!auditLog) {
        return;
      }

      const auditEvent = auditLog.startEvent({
        operationId,
        scope: "bulk",
        action,
        targetBlockedState,
        agentId: agent.id,
        agentDisplayName: agent.displayName,
        actor: request.session.user!,
        requestPath: request.originalUrl,
      });

      auditEvents.set(agent.id, auditEvent);
    },
    onPackageResult(result: BulkPackageResult) {
      completeAuditEvent(auditEvents.get(result.id), {
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
