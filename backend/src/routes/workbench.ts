import { Router } from "express";
import { PackageInventoryRepository } from "../db/packageInventory.js";
import { PowerPlatformInventoryRepository } from "../db/powerPlatformInventory.js";
import { OfficialUsageRepository } from "../db/officialUsage.js";
import { requestScope } from "../middleware/auth.js";
import { bulkJobs } from "../services/bulkJobs.js";
import { copilotStudioQuarantineJobs } from "../services/copilotStudioQuarantineJobs.js";
import { defenderHunting } from "../services/defenderHunting.js";
import { purviewAudit } from "../services/purviewAudit.js";
import { getWorkbenchMetadata } from "../services/workbenchMetadata.js";
import type { WorkbenchJobSource, WorkbenchJobSummary, WorkbenchJobsResponse } from "../types/workbench.js";
import { hasAppRole } from "../types/capability.js";
import { policyRoute } from "./policy.js";

export const workbenchRouter = Router();
const packageRepository = new PackageInventoryRepository();
const inventoryRepository = new PowerPlatformInventoryRepository();
const officialUsageRepository = new OfficialUsageRepository();

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
  if (hasAppRole(user.roles, "AgentControl.Viewer")) {
    loaders.push({ source: "package-refresh", load: async () => (await packageRepository.listJobs(scope, user.homeAccountId, 20)).value.map(job => ({
      id: job.id, source: "package-refresh", label: "Package inventory refresh",
      target: job.scopeKind === "exact" ? `${job.requestedIds.length} exact Graph package target${job.requestedIds.length === 1 ? "" : "s"}` : "Current principal Graph package catalog",
      status: job.status, total: job.totalRecords, completed: job.observedCount, partial: false,
      canResume: job.status === "waiting_authorization", canCancel: ["waiting_authorization", "running"].includes(job.status), canReconcile: false,
      updatedAt: job.updatedAt,
      href: `/agents?refreshJob=${encodeURIComponent(job.id)}${job.tokenMode === "application" ? "&mode=application" : ""}` as const,
    })) });
  }
  if (hasAppRole(user.roles, "AgentControl.Viewer")) {
    loaders.push({ source: "power-platform", load: async () => (await inventoryRepository.listJobs(scope, 20)).value.map(job => ({
      id: job.id, source: "power-platform", label: "Power Platform inventory refresh",
      target: `${job.requestedTypes.length} allowlisted resource type${job.requestedTypes.length === 1 ? "" : "s"}${job.environmentScope ? " in one exact environment" : ""}`,
      status: job.status, total: job.totalRecords, completed: job.observedCount, partial: false,
      canResume: job.status === "waiting_authorization", canCancel: ["waiting_authorization", "running"].includes(job.status), canReconcile: false,
      updatedAt: job.updatedAt, href: `/power-platform?refreshJob=${encodeURIComponent(job.id)}` as const,
    })) });
  }
  if (hasAppRole(user.roles, "AgentControl.Viewer")) {
    loaders.push({ source: "package-controls", load: async () => (await bulkJobs.list(scope, 20)).value.map(job => ({
      id: job.id, source: "package-controls", label: `Package ${job.action}`,
      target: `${job.total} exact Graph package target${job.total === 1 ? "" : "s"}`,
      status: job.status, total: job.total, completed: job.completed, partial: job.status === "partial" || job.inconclusive > 0,
      canResume: hasAppRole(user.roles, "AgentControl.Admin") && job.canResume,
      canCancel: hasAppRole(user.roles, "AgentControl.Admin") && ["queued", "running", "waiting_authorization"].includes(job.status),
      canReconcile: hasAppRole(user.roles, "AgentControl.Admin") && job.results.some(result => result.status === "inconclusive" && result.reconciliationStatus === "required"),
      updatedAt: job.updatedAt, href: `/agents?controlJob=${encodeURIComponent(job.id)}` as const,
    })) });
    loaders.push({ source: "quarantine", load: async () => (await copilotStudioQuarantineJobs.list(scope, 20)).value.map(job => ({
      id: job.id, source: "quarantine", label: `Copilot Studio ${job.action}`,
      target: `${job.total} exact environment/CDS bot target${job.total === 1 ? "" : "s"}`,
      status: job.status, total: job.total, completed: job.completed, partial: job.status === "partial" || job.inconclusive > 0,
      canResume: hasAppRole(user.roles, "AgentControl.Admin") && job.canResume,
      canCancel: hasAppRole(user.roles, "AgentControl.Admin") && ["queued", "running", "waiting_authorization"].includes(job.status),
      canReconcile: hasAppRole(user.roles, "AgentControl.Admin") && job.canReconcile,
      updatedAt: job.updatedAt, href: `/power-platform?quarantineJob=${encodeURIComponent(job.id)}` as const,
    })) });
  }
  if (hasAppRole(user.roles, "AgentControl.Viewer")) {
    loaders.push({ source: "purview", load: async () => (await purviewAudit.list(user, 20, 0)).value.map(job => ({
      id: job.id, source: "purview", label: "Purview Audit Search",
      target: `${job.filters.presetId} · ${job.filters.startDateTime} to ${job.filters.endDateTime}`,
      status: job.status, total: job.providerRowCount || null, completed: job.storedRowCount, partial: job.status === "partial",
      canResume: job.canResume, canCancel: ["waiting_authorization", "reconciling_create", "running"].includes(job.status),
      canReconcile: false, updatedAt: job.updatedAt, expiresAt: job.expiresAt,
      href: `/audit?source=purview&job=${encodeURIComponent(job.id)}` as const,
    })) });
    loaders.push({ source: "defender", load: async () => (await defenderHunting.list(user, 20, 0)).value.map(job => ({
      id: job.id, source: "defender", label: "Defender fixed-template investigation",
      target: `${job.filters.templateId} · ${job.filters.startDateTime} to ${job.filters.endDateTime}`,
      status: job.status, total: job.providerRowCount || null, completed: job.storedRowCount, partial: job.status === "partial",
      canResume: job.canResume, canCancel: ["waiting_authorization", "running"].includes(job.status),
      canReconcile: false, updatedAt: job.updatedAt, expiresAt: job.expiresAt,
      href: `/security?job=${encodeURIComponent(job.id)}` as const,
    })) });
  }
  if (hasAppRole(user.roles, "AgentControl.Admin")) {
    loaders.push({ source: "official-usage", load: async () => (await officialUsageRepository.getAdminState(scope)).staging.map(stage => ({
      id: stage.id, source: "official-usage", label: "Official usage import staging",
      target: `${stage.kind} · ${stage.rowCount} validated row${stage.rowCount === 1 ? "" : "s"}`,
      status: stage.status, total: stage.rowCount, completed: stage.rowCount, partial: false,
      canResume: false, canCancel: stage.status === "active", canReconcile: false,
      updatedAt: stage.createdAt, expiresAt: stage.expiresAt,
      href: `/official-usage?staging=${encodeURIComponent(stage.id)}` as const,
    })) });
  }
  const settled = await Promise.allSettled(loaders.map(loader => loader.load()));
  const value = settled.flatMap(result => result.status === "fulfilled" ? result.value : [])
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)).slice(0, 100);
  const unavailableSources = settled.flatMap((result, index) => result.status === "rejected"
    ? [{ source: loaders[index].source, code: "source_unavailable" as const }] : []);
  const body: WorkbenchJobsResponse = { value, unavailableSources, polledAt: new Date().toISOString(), requestId: response.locals.requestId };
  response.json(body);
});
