import { Router } from "express";
import { getTenantConfiguration } from "../config.js";
import { AppError } from "../errors.js";
import { PackageInventoryRepository } from "../db/packageInventory.js";
import { PowerPlatformInventoryRepository } from "../db/powerPlatformInventory.js";
import { requestScope } from "../middleware/auth.js";
import { capabilities } from "../services/capabilities.js";
import { dataSync } from "../services/dataSync.js";
import { getWorkbenchMetadata } from "../services/workbenchMetadata.js";
import type { WorkbenchJobSource, WorkbenchJobSummary, WorkbenchJobsResponse } from "../types/workbench.js";
import type { DataSyncRun } from "../types/dataSync.js";
import { policyRoute } from "./policy.js";

export const workbenchRouter = Router();
const packageRepository = new PackageInventoryRepository();
const inventoryRepository = new PowerPlatformInventoryRepository();
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
  const loaders: Array<{ source: WorkbenchJobSource; load: () => Promise<WorkbenchJobSummary[]> }> = [
    { source: "data-sync", load: async () => (await dataSync.listRuns(scope, 20)).map(dataSyncJobSummary) },
    { source: "package-refresh", load: async () => (await packageRepository.listJobs(scope, user.homeAccountId, 20)).value.map(packageRefreshJobSummary) },
    { source: "power-platform", load: async () => (await inventoryRepository.listJobs(scope, 20)).value.map(powerPlatformJobSummary) },
  ];
  const applicationPrincipalId = getTenantConfiguration(scope.tenantId).clientId;
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
  const settled = await Promise.allSettled(loaders.map(loader => loader.load()));
  const value = settled.flatMap(result => result.status === "fulfilled" ? result.value : [])
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)).slice(0, 100);
  const unavailableSources = [...new Set(settled.flatMap((result, index) => result.status === "rejected"
    ? [loaders[index].source] : []))].map(source => ({ source, code: "source_unavailable" as const }));
  const body: WorkbenchJobsResponse = { value, unavailableSources, polledAt: new Date().toISOString(), requestId: response.locals.requestId };
  response.json(body);
});
