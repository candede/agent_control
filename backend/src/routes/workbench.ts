import { Router } from "express";
import { config } from "../config.js";
import { AppError } from "../errors.js";
import { PackageInventoryRepository } from "../db/packageInventory.js";
import { PowerPlatformInventoryRepository } from "../db/powerPlatformInventory.js";
import { OfficialUsageRepository } from "../db/officialUsage.js";
import { requestScope } from "../middleware/auth.js";
import { bulkJobs } from "../services/bulkJobs.js";
import { capabilities } from "../services/capabilities.js";
import { copilotStudioQuarantineJobs } from "../services/copilotStudioQuarantineJobs.js";
import { defenderHunting } from "../services/defenderHunting.js";
import { dataSync } from "../services/dataSync.js";
import { purviewAudit } from "../services/purviewAudit.js";
import { getWorkbenchMetadata } from "../services/workbenchMetadata.js";
import type { WorkbenchJobSource, WorkbenchJobSummary, WorkbenchJobsResponse } from "../types/workbench.js";
import type { DataSyncRun } from "../types/dataSync.js";
import type { PurviewAuditJob } from "../types/purviewAudit.js";
import type { DefenderHuntingJob } from "../types/defenderHunting.js";
import { hasAppRole } from "../types/capability.js";
import { policyRoute } from "./policy.js";

export const workbenchRouter = Router();
const packageRepository = new PackageInventoryRepository();
const inventoryRepository = new PowerPlatformInventoryRepository();
const officialUsageRepository = new OfficialUsageRepository();
const syncSourceLabels = {
  users: "Users",
  graph_packages: "Graph packages",
  power_platform: "Power Platform",
  usage_reports: "Usage reports",
};

export function dataSyncJobSummary(run: DataSyncRun): WorkbenchJobSummary {
  const completed = run.sources.filter(source => source.status === "succeeded").length;
  return {
    id: run.id,
    source: "data-sync",
    label: run.mode === "initial" ? "Initial data sync" : run.mode === "full" ? "Full data resync" : "Data sync",
    target: run.sources.map(source => syncSourceLabels[source.source]).join(", "),
    status: run.status,
    total: run.sources.length,
    completed,
    partial: run.status === "partial" || run.sources.some(source => ["partial", "failed", "permission_required"].includes(source.status)),
    canResume: run.status !== "running" && run.sources.some(source => source.canRetry),
    canCancel: !["completed", "cancelled"].includes(run.status)
      && run.sources.some(source => ["queued", "running", "waiting_authorization", "awaiting_upload"].includes(source.status)),
    canReconcile: false,
    createdAt: run.startedAt,
    startedAt: run.startedAt,
    ...(run.completedAt ? { completedAt: run.completedAt } : {}),
    syncSources: run.sources.map(source => source.source),
    updatedAt: run.updatedAt,
    href: `/sync?syncRun=${encodeURIComponent(run.id)}`,
  };
}

export function packageRefreshJobSummary(
  job: Awaited<ReturnType<PackageInventoryRepository["listJobs"]>>["value"][number],
): WorkbenchJobSummary {
  return {
    id: job.id, source: "package-refresh", label: "Package inventory refresh", tokenMode: job.tokenMode,
    target: job.scopeKind === "exact" ? `${job.requestedIds.length} exact Graph package target${job.requestedIds.length === 1 ? "" : "s"}`
      : job.tokenMode === "application" ? "Application Graph package catalog" : "Current principal Graph package catalog",
    status: job.status, total: job.totalRecords, completed: job.observedCount, partial: false,
    canResume: job.status === "waiting_authorization", canCancel: ["waiting_authorization", "running"].includes(job.status), canReconcile: false,
    ...sourceJobDates(job),
    updatedAt: job.updatedAt,
    href: `/sync?refreshJob=${encodeURIComponent(job.id)}${job.tokenMode === "application" ? "&mode=application" : ""}`,
  };
}

export function powerPlatformJobSummary(
  job: Awaited<ReturnType<PowerPlatformInventoryRepository["listJobs"]>>["value"][number],
): WorkbenchJobSummary {
  return {
    id: job.id, source: "power-platform", label: "Power Platform inventory refresh",
    target: `${job.requestedTypes.length} allowlisted resource type${job.requestedTypes.length === 1 ? "" : "s"}${job.environmentScope ? " in one exact environment" : ""}`,
    status: job.status, total: job.totalRecords, completed: job.observedCount, partial: false,
    canResume: job.status === "waiting_authorization", canCancel: ["waiting_authorization", "running"].includes(job.status), canReconcile: false,
    ...sourceJobDates(job),
    updatedAt: job.updatedAt, href: `/sync?powerPlatformJob=${encodeURIComponent(job.id)}`,
  };
}

function sourceJobDates(job: { createdAt: string; attemptedAt: string | null; finishedAt: string | null }) {
  return {
    createdAt: job.createdAt,
    ...(job.attemptedAt ? { startedAt: job.attemptedAt } : {}),
    ...(job.finishedAt ? { completedAt: job.finishedAt } : {}),
  };
}

export function purviewJobSummary(job: PurviewAuditJob): WorkbenchJobSummary {
  return {
    id: job.id, source: "purview", label: "Purview Audit Search",
    target: `${job.filters.presetId} · ${job.filters.startDateTime} to ${job.filters.endDateTime}`,
    status: job.status, total: job.pageComplete || job.providerRowCount > 0 ? job.providerRowCount : null,
    completed: job.storedRowCount, partial: job.status === "partial",
    canResume: job.canResume, canCancel: ["waiting_authorization", "reconciling_create", "running"].includes(job.status),
    canReconcile: false, ...sourceJobDates(job), updatedAt: job.updatedAt, expiresAt: job.expiresAt,
    href: `/audit?source=purview&job=${encodeURIComponent(job.id)}`,
  };
}

export function defenderJobSummary(job: DefenderHuntingJob): WorkbenchJobSummary {
  return {
    id: job.id, source: "defender", label: "Defender fixed-template investigation",
    target: `${job.filters.templateId} · ${job.filters.startDateTime} to ${job.filters.endDateTime}`,
    status: job.status, total: job.complete || job.providerRowCount > 0 ? job.providerRowCount : null,
    completed: job.storedRowCount, partial: job.status === "partial",
    canResume: job.canResume, canCancel: ["waiting_authorization", "running"].includes(job.status),
    canReconcile: false, ...sourceJobDates(job), updatedAt: job.updatedAt, expiresAt: job.expiresAt,
    href: `/security?job=${encodeURIComponent(job.id)}`,
  };
}

export function officialUsageJobSummary(
  stage: Awaited<ReturnType<OfficialUsageRepository["getAdminState"]>>["staging"][number],
): WorkbenchJobSummary {
  const kindLabels = { agents: "Agents", userAgents: "Users & agents", users: "Users" };
  const history = stage.status === "accepted" && stage.acceptedSetId
    ? `/sync?reports=snapshot&snapshot=${encodeURIComponent(stage.acceptedSetId)}` as const
    : "/sync?reports=manage";
  return {
    id: stage.id, source: "official-usage", label: `${kindLabels[stage.kind]} CSV import`,
    target: `${kindLabels[stage.kind]} export · ${stage.rowCount} validated row${stage.rowCount === 1 ? "" : "s"}`,
    status: stage.status, total: stage.rowCount, completed: stage.rowCount, partial: false,
    canResume: false, canCancel: stage.status === "active", canReconcile: false,
    createdAt: stage.createdAt,
    ...(stage.acceptedAt ? { completedAt: stage.acceptedAt } : {}),
    updatedAt: stage.acceptedAt ?? stage.createdAt, expiresAt: stage.expiresAt,
    href: stage.status === "active" ? `/sync?reports=import&staging=${encodeURIComponent(stage.id)}` : history,
  };
}

policyRoute(workbenchRouter, "get", "/workbench/metadata", {
  access: "authenticated",
  dataClass: "operational_metadata",
  roles: ["AgentControl.Viewer"],
}, (_request, response) => {
  response.json(getWorkbenchMetadata());
});

policyRoute(workbenchRouter, "get", "/workbench/jobs", {
  access: "authenticated",
  dataClass: "operational_metadata",
  roles: ["AgentControl.Viewer"],
}, async (request, response) => {
  const user = request.session.user!;
  const scope = requestScope(request);
  const loaders: Array<{ source: WorkbenchJobSource; load: () => Promise<WorkbenchJobSummary[]> }> = [];
  loaders.push({ source: "data-sync", load: async () => (await dataSync.listRuns(scope, 20)).map(dataSyncJobSummary) });
  if (hasAppRole(user.roles, "AgentControl.Viewer")) {
    loaders.push({ source: "package-refresh", load: async () => (await packageRepository.listJobs(scope, user.homeAccountId, 20)).value.map(packageRefreshJobSummary) });
    const applicationPrincipalId = config.clientId;
    if (applicationPrincipalId) {
      loaders.push({ source: "package-refresh", load: async () => {
        try {
          await capabilities.requireApplicationDataScope("graph.package.read.application", user);
        } catch (error) {
          if (error instanceof AppError && error.code === "not_configured") return [];
          throw error;
        }
        return (await packageRepository.listJobs(
          { tenantId: scope.tenantId, principalId: applicationPrincipalId }, user.homeAccountId, 20,
        )).value.map(packageRefreshJobSummary);
      } });
    }
  }
  if (hasAppRole(user.roles, "AgentControl.Viewer")) {
    loaders.push({ source: "power-platform", load: async () => (await inventoryRepository.listJobs(scope, 20)).value.map(powerPlatformJobSummary) });
  }
  if (hasAppRole(user.roles, "AgentControl.Viewer")) {
    loaders.push({ source: "package-controls", load: async () => (await bulkJobs.list(scope, 20)).value.map(job => ({
      id: job.id, source: "package-controls", label: `Package ${job.action}`,
      target: `${job.total} exact Graph package target${job.total === 1 ? "" : "s"}`,
      status: job.status, total: job.total, completed: job.completed, partial: job.status === "partial" || job.inconclusive > 0,
      canResume: hasAppRole(user.roles, "AgentControl.Admin") && job.canResume,
      canCancel: hasAppRole(user.roles, "AgentControl.Admin") && (["queued", "running", "waiting_authorization"].includes(job.status)
        || job.status === "partial" && job.completed < job.total),
      canReconcile: hasAppRole(user.roles, "AgentControl.Admin") && job.results.some(result => result.status === "inconclusive" && result.reconciliationStatus === "required"),
      createdAt: job.createdAt, updatedAt: job.updatedAt, href: `/agents?controlJob=${encodeURIComponent(job.id)}` as const,
    })) });
    loaders.push({ source: "quarantine", load: async () => (await copilotStudioQuarantineJobs.list(scope, 20)).value.map(job => ({
      id: job.id, source: "quarantine", label: `Copilot Studio ${job.action}`,
      target: `${job.total} exact environment/CDS bot target${job.total === 1 ? "" : "s"}`,
      status: job.status, total: job.total, completed: job.completed, partial: job.status === "partial" || job.inconclusive > 0,
      canResume: hasAppRole(user.roles, "AgentControl.Admin") && job.canResume,
      canCancel: hasAppRole(user.roles, "AgentControl.Admin") && (["queued", "running", "waiting_authorization"].includes(job.status)
        || job.status === "inconclusive" && job.completed < job.total),
      canReconcile: hasAppRole(user.roles, "AgentControl.Admin") && job.canReconcile,
      createdAt: job.createdAt, updatedAt: job.updatedAt, href: `/agents?quarantineJob=${encodeURIComponent(job.id)}` as const,
    })) });
  }
  if (hasAppRole(user.roles, "AgentControl.Viewer")) {
    loaders.push({ source: "purview", load: async () => (await purviewAudit.list(user, 20, 0)).value.map(job => ({
      ...purviewJobSummary(job), canResume: job.canResume && job.authorizationPrincipalId === user.homeAccountId,
    })) });
    loaders.push({ source: "defender", load: async () => (await defenderHunting.list(user, 20, 0)).value.map(job => ({
      ...defenderJobSummary(job), canResume: job.canResume && job.authorizationPrincipalId === user.homeAccountId,
    })) });
  }
  if (hasAppRole(user.roles, "AgentControl.Admin")) {
    loaders.push({ source: "official-usage", load: async () => (await officialUsageRepository.getAdminState(scope)).staging.map(officialUsageJobSummary) });
  }
  const settled = await Promise.allSettled(loaders.map(loader => loader.load()));
  const value = settled.flatMap(result => result.status === "fulfilled" ? result.value : [])
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)).slice(0, 100);
  const unavailableSources = [...new Set(settled.flatMap((result, index) => result.status === "rejected"
    ? [loaders[index].source] : []))].map(source => ({ source, code: "source_unavailable" as const }));
  const body: WorkbenchJobsResponse = { value, unavailableSources, polledAt: new Date().toISOString(), requestId: response.locals.requestId };
  response.json(body);
});
