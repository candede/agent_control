import { randomUUID } from "node:crypto";
import type pg from "pg";
import { pool } from "../db/pool.js";
import { DataSyncRepository, type DataSyncScope } from "../db/dataSync.js";
import { OfficialUsageRepository } from "../db/officialUsage.js";
import { AppError, errorTelemetry } from "../errors.js";
import { automaticDataSyncSourceIds, type DataSyncRun, type DataSyncSourceId, type DataSyncSourceStatus, type DataSyncState, type StartDataSyncInput } from "../types/dataSync.js";
import { hasAppRole } from "../types/capability.js";
import type { AuthenticatedUser } from "../types/session.js";
import type { PublishedOfficialUsage } from "../types/officialUsage.js";
import { CopilotUsageService, type CopilotUsageRefreshResult } from "./copilotUsage.js";
import { packageInventory, type PackageInventoryService } from "./packageInventory.js";
import { powerPlatformInventory, type PowerPlatformInventoryService } from "./powerPlatformInventory.js";
import { powerPlatformResourceTypes } from "../types/powerPlatformInventory.js";
import { operationalLog } from "./telemetry.js";
import { AgentPeopleService } from "./agentPeople.js";

type PackageJob = Awaited<ReturnType<PackageInventoryService["get"]>>;
type PowerPlatformJob = Awaited<ReturnType<PowerPlatformInventoryService["get"]>>;

type DataSyncDependencies = {
  repository: Pick<DataSyncRepository,
    "submit" | "getRun" | "getLatestRun" | "listRuns" | "getSourceAttempt" | "listMarkers" | "attachJob" | "updateSource"
    | "recordSuccessMarker" | "retry" | "cancel" | "pausePrincipal" | "recoverInterrupted">;
  officialUsage: Pick<OfficialUsageRepository, "getPublished">;
  packages: Pick<PackageInventoryService, "submit" | "start" | "get" | "cancel" | "waitForPrincipalAuthorization">;
  powerPlatform: Pick<PowerPlatformInventoryService, "submit" | "start" | "get" | "cancel" | "waitForPrincipalAuthorization">;
  copilotUsage: Pick<CopilotUsageService, "refreshUsers">;
  agentPeople: Pick<AgentPeopleService, "refreshReferences">;
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

type ActiveRun = {
  runId: string;
  scope: DataSyncScope;
  user: AuthenticatedUser;
  controller: AbortController;
  operation: Promise<void>;
  children: Map<string, TrackedChild>;
  cleanupFailures: Map<string, unknown>;
};

type TrackedChild = {
  source: "graph_packages" | "power_platform";
  jobId: string;
};

type RunAdmission = {
  scope: DataSyncScope;
  runId?: string;
  controller: AbortController;
  operation: Promise<DataSyncRun>;
};

const maximumActiveRuns = 4;
const childPollIntervalMs = 250;

export class DataSyncService {
  private readonly active = new Map<string, ActiveRun>();
  private readonly admissions = new Set<RunAdmission>();
  private readonly cancelling = new Set<string>();
  private draining = false;

  constructor(
    database: pg.Pool = pool,
    private readonly dependencies: DataSyncDependencies = defaultDependencies(database),
  ) {}

  async state(user: AuthenticatedUser): Promise<DataSyncState> {
    requireViewer(user);
    const scope = dataScope(user);
    let run = await this.dependencies.repository.getLatestRun(scope);
    const published = await this.dependencies.officialUsage.getPublished(scope.tenantId);
    if (run) run = await this.reconcileRun(user, scope, run, published);
    if (hasAcceptedUsage(published)) {
      await this.dependencies.repository.recordSuccessMarker(scope, "usage_reports", usageRowCount(published), usageAcceptedAt(published));
    }
    const markers = await this.dependencies.repository.listMarkers(scope);
    const usageImportRequired = !hasAcceptedUsage(published);
    const sources = reconcileUsageMarker(markers, published);
    return {
      onboardingRequired: automaticDataSyncSourceIds.some(id => sources.find(source => source.source === id)?.status !== "succeeded"),
      usageImportRequired,
      run: run ?? null,
      sources,
    };
  }

  listRuns(scope: DataSyncScope, limit = 20) {
    return this.dependencies.repository.listRuns(scope, limit);
  }

  async getRun(scope: DataSyncScope, id: string) {
    validateRunId(id);
    const run = await this.dependencies.repository.getRun(scope, id);
    if (!run) throw new AppError(404, "not_found", "Data sync run was not found.");
    return this.reconcileUsage(scope, run);
  }

  async start(user: AuthenticatedUser, input: StartDataSyncInput): Promise<DataSyncRun> {
    requireViewer(user);
    return this.admit(user, undefined, async (scope, signal) => {
      const submitted = await this.dependencies.repository.submit(scope, input);
      signal.throwIfAborted();
      let run = await this.reconcileUsage(scope, submitted.run);
      signal.throwIfAborted();
      if (submitted.created && run.sources.some(source => executableSource(source))) {
        this.launch(user, scope, run.id, run.sources.filter(executableSource).map(source => source.source), false);
        run = (await this.dependencies.repository.getRun(scope, run.id)) ?? run;
      }
      signal.throwIfAborted();
      return run;
    });
  }

  async retry(user: AuthenticatedUser, id: string, sources?: readonly DataSyncSourceId[]): Promise<DataSyncRun> {
    requireViewer(user);
    validateRunId(id);
    return this.admit(user, id, async (scope, signal) => {
      const current = await this.dependencies.repository.getRun(scope, id);
      signal.throwIfAborted();
      if (!current) throw new AppError(404, "not_found", "Data sync run was not found.");
      const reconciled = await this.reconcileRun(user, scope, current, await this.dependencies.officialUsage.getPublished(scope.tenantId));
      signal.throwIfAborted();
      const candidates = reconciled.sources.filter(source => source.canRetry).map(source => source.source);
      const requested = sources ?? candidates;
      if (!requested.length) throw new AppError(409, "data_sync_nothing_to_retry", "This data sync run has no incomplete sources to retry.");
      if (requested.some(source => !candidates.includes(source))) {
        throw new AppError(409, "data_sync_source_complete", "Only incomplete data sync sources can be retried.");
      }
      const cancelFailures = await this.cancelChildJobs(user, reconciled, requested);
      if (cancelFailures.length) throw cancelFailures[0];
      signal.throwIfAborted();
      const selected = await this.dependencies.repository.retry(scope, id, requested);
      signal.throwIfAborted();
      this.launch(user, scope, id, selected.filter(source => source !== "usage_reports"), true);
      const run = (await this.dependencies.repository.getRun(scope, id))!;
      signal.throwIfAborted();
      return run;
    });
  }

  async cancel(user: AuthenticatedUser, id: string): Promise<DataSyncRun> {
    requireViewer(user);
    validateRunId(id);
    const scope = dataScope(user);
    if (this.cancelling.has(id)) throw new AppError(409, "data_sync_active", "The data sync run is already stopping.");
    this.cancelling.add(id);
    try {
      const before = await this.dependencies.repository.getRun(scope, id);
      if (!before) throw new AppError(404, "not_found", "Data sync run was not found.");
      const reason = new AppError(409, "read_job_cancelled", "Data sync was cancelled.");
      const admissions = this.stopAdmissions(reason, scope, id);
      if (admissions) await admissions;
      const active = this.active.get(id);
      const tracker = active ?? childTracker(id, scope, user);
      tracker.controller.abort(reason);
      const cancelled = await this.dependencies.repository.cancel(scope, id);
      this.trackPersistedChildren(tracker, before);
      await this.cleanupTrackedChildren(tracker);
      const [operation] = await Promise.allSettled(active ? [active.operation] : []);
      const current = await this.dependencies.repository.getRun(scope, id);
      if (current) this.trackPersistedChildren(tracker, current);
      await this.cleanupTrackedChildren(tracker);
      this.throwIfCleanupFailed(id, tracker);
      if (operation?.status === "rejected") throw operation.reason;
      return current ?? cancelled;
    } finally {
      this.cancelling.delete(id);
    }
  }

  async recover() {
    const count = await this.dependencies.repository.recoverInterrupted();
    if (count) operationalLog("warn", "data_sync_recovered", { count });
    return count;
  }

  async drain() {
    this.draining = true;
    const admissions = this.stopAdmissions(new AppError(401, "interaction_required", "Application shutdown requires explicit data sync authorization."));
    const active = [...this.active.values()];
    for (const run of active) {
      run.controller.abort(new AppError(401, "interaction_required", "Application shutdown requires explicit data sync authorization."));
    }
    const results = await Promise.allSettled([
      admissions,
      ...active.map(run => this.dependencies.repository.pausePrincipal(run.scope, "Application shutdown requires explicit resume with current authorization.")),
      ...active.map(run => run.operation),
    ]);
    const cleanup = await this.cleanupRuns(active);
    const failure = [...results, ...cleanup].find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }

  async waitForPrincipalAuthorization(scope: DataSyncScope) {
    const admissions = this.stopAdmissions(new AppError(401, "interaction_required", "The signed-in account changed during data sync."), scope);
    const active = [...this.active.values()].filter(run =>
      run.scope.tenantId === scope.tenantId && run.scope.principalId === scope.principalId);
    for (const run of active) {
      run.controller.abort(new AppError(401, "interaction_required", "The signed-in account changed during data sync."));
    }
    const results = await Promise.allSettled([
      admissions,
      this.dependencies.packages.waitForPrincipalAuthorization(scope),
      this.dependencies.powerPlatform.waitForPrincipalAuthorization(scope),
      this.dependencies.repository.pausePrincipal(scope, "Sign-out requires explicit resume with current authorization."),
    ]);
    const operations = await Promise.allSettled(active.map(run => run.operation));
    const cleanup = await this.cleanupRuns(active);
    const failure = [...results, ...operations, ...cleanup].find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }

  private admit(
    user: AuthenticatedUser,
    runId: string | undefined,
    operation: (scope: DataSyncScope, signal: AbortSignal) => Promise<DataSyncRun>,
  ) {
    if (this.draining) throw new AppError(503, "data_sync_shutdown", "Data sync is stopping for application shutdown.");
    if (runId && (this.active.has(runId) || this.cancelling.has(runId)
      || [...this.admissions].some(admission => admission.runId === runId))) {
      throw new AppError(409, "data_sync_active", "The data sync run is already executing or stopping.");
    }
    if (this.active.size + this.admissions.size >= maximumActiveRuns) {
      throw new AppError(429, "data_sync_capacity", "At most four data sync runs can execute at once.");
    }
    const scope = dataScope(user);
    const controller = new AbortController();
    const admission: RunAdmission = {
      scope, runId, controller,
      operation: Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return operation(scope, controller.signal);
      }).catch(async error => {
        if (controller.signal.aborted) {
          await this.dependencies.repository.pausePrincipal(scope, "Interrupted admission requires explicit resume with current authorization.");
        }
        throw error;
      }).finally(() => this.admissions.delete(admission)),
    };
    this.admissions.add(admission);
    return admission.operation;
  }

  private stopAdmissions(reason: AppError, scope?: DataSyncScope, runId?: string) {
    const admissions = [...this.admissions].filter(admission =>
      (!scope || admission.scope.tenantId === scope.tenantId && admission.scope.principalId === scope.principalId)
      && (!runId || !admission.runId || admission.runId === runId));
    if (!admissions.length) return;
    for (const admission of admissions) admission.controller.abort(reason);
    return Promise.allSettled(admissions.map(admission => admission.operation)).then(results => {
      const failure = results.find((result, index) =>
        result.status === "rejected" && result.reason !== admissions[index].controller.signal.reason);
      if (failure?.status === "rejected") throw failure.reason;
    });
  }

  private cleanupRuns(runs: readonly ActiveRun[]) {
    return Promise.allSettled(runs.map(async run => {
      const current = await this.dependencies.repository.getRun(run.scope, run.runId);
      if (current) this.trackPersistedChildren(run, current);
      await this.cleanupTrackedChildren(run);
      this.throwIfCleanupFailed(run.runId, run);
    }));
  }

  private launch(
    user: AuthenticatedUser,
    scope: DataSyncScope,
    runId: string,
    sources: readonly DataSyncSourceId[],
    incompleteOnly: boolean,
  ) {
    if (this.active.has(runId) || !sources.length) return;
    const controller = new AbortController();
    const activeRun: ActiveRun = {
      runId,
      scope,
      user,
      controller,
      operation: Promise.resolve(),
      children: new Map(),
      cleanupFailures: new Map(),
    };
    this.active.set(runId, activeRun);
    const operation = Promise.resolve()
      .then(() => this.run(user, scope, runId, sources, incompleteOnly, controller.signal, activeRun))
      .catch(async error => {
        operationalLog("error", "data_sync_worker_failed", { runId, ...errorTelemetry(error) });
        const current = await this.dependencies.repository.getRun(scope, runId);
        for (const source of current?.sources ?? []) {
          if (sources.includes(source.source) && ["queued", "running"].includes(source.status)) {
            await this.dependencies.repository.updateSource(scope, runId, source.source, {
              status: authorizationStatus(error),
              message: safeSyncFailure(error),
              canRetry: true,
            });
          }
        }
      })
      .finally(() => {
        if (this.active.get(runId)?.operation === operation) this.active.delete(runId);
      });
    activeRun.operation = operation;
    void operation.catch(error => {
      operationalLog("error", "data_sync_worker_status_failed", { runId, ...errorTelemetry(error) });
    });
  }

  private async run(
    user: AuthenticatedUser,
    scope: DataSyncScope,
    runId: string,
    sources: readonly DataSyncSourceId[],
    incompleteOnly: boolean,
    signal: AbortSignal,
    activeRun: ActiveRun,
  ) {
    const inventoryReady = sources.includes("power_platform")
      ? this.runPowerPlatform(user, scope, runId, signal, activeRun, incompleteOnly) : undefined;
    const results = await Promise.allSettled(sources.map(source => {
      if (source === "users") return this.runUsers(user, scope, runId, incompleteOnly, signal, inventoryReady);
      if (source === "graph_packages") return this.runPackages(user, scope, runId, signal, activeRun, incompleteOnly);
      if (source === "power_platform") return inventoryReady;
      return Promise.resolve();
    }));
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }

  private async runUsers(
    user: AuthenticatedUser,
    scope: DataSyncScope,
    runId: string,
    incompleteOnly: boolean,
    signal: AbortSignal,
    inventoryReady: Promise<void> | undefined,
  ) {
    const jobId = randomUUID();
    let observedCount: number | null = null;
    const progress = async (message: string, count: number | null = null) => {
      signal.throwIfAborted();
      const current = await this.dependencies.repository.updateSource(scope, runId, "users", {
        status: "running", jobId, count, message, canRetry: false,
      });
      signal.throwIfAborted();
      const source = current?.sources.find(value => value.source === "users");
      if (source?.jobId !== jobId || source.status !== "running") {
        throw new AppError(409, "data_sync_publication_superseded", "This user-source attempt stopped or was superseded.");
      }
    };
    try {
      await this.dependencies.repository.attachJob(scope, runId, "users", jobId);
      await progress("Checking M365 Copilot feature eligibility and app-activity sources, not all tenant accounts.");
      let result = await this.dependencies.copilotUsage.refreshUsers(user, signal, {
        incompleteOnly, publication: { runId, jobId },
        onDirectoryProgress: async count => {
          observedCount = count;
          await progress(`Checked ${count} directory users from Copilot-capable products and active report identities. License verification and app-activity collection are in progress.`, count);
        },
      });
      signal.throwIfAborted();
      if (inventoryReady) {
        await progress("Directory checks and app-activity collection finished. Waiting for Power Platform inventory before resolving agent people.");
        await inventoryReady;
      }
      await progress("Directory checks and app-activity collection finished. Resolving agent people from saved inventory references.");
      try {
        const people = await this.dependencies.agentPeople.refreshReferences(user, signal, { runId, jobId }, { incompleteOnly });
        result = {
          ...result,
          status: people.failed && result.status === "succeeded" ? "partial" : result.status,
          count: people.failed && result.status === "succeeded" ? observedCount : result.count,
          message: `${result.message} Agent people: ${people.resolved} resolved, ${people.notFound} not found, ${people.failed} lookup failures.`,
        };
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof AppError && error.code === "data_sync_publication_superseded") throw error;
        operationalLog("warn", "agent_people_sync_failed", { ...errorTelemetry(error), jobId });
        result = {
          ...result, status: result.status === "succeeded" ? "partial" : result.status,
          count: result.status === "succeeded" ? observedCount : result.count,
          message: `${result.message} Agent people were not fully refreshed. ${error instanceof AppError ? error.message : "Directory lookup failed; retry Users sync."}`,
        };
      }
      signal.throwIfAborted();
      await this.dependencies.repository.updateSource(scope, runId, "users", userSourceUpdate(jobId, result));
    } catch (error) {
      await this.handleSourceFailure(scope, runId, "users", jobId, error);
    }
  }

  private async runPackages(user: AuthenticatedUser, scope: DataSyncScope, runId: string, signal: AbortSignal, activeRun: ActiveRun, retryFailed: boolean) {
    let jobId: string | null = null;
    try {
      signal.throwIfAborted();
      const attempt = await this.dependencies.repository.getSourceAttempt(scope, runId, "graph_packages");
      signal.throwIfAborted();
      const job = await this.dependencies.packages.submit(user, {
        tokenMode: "delegated",
        requestedIds: [],
        idempotencyKey: childIdempotencyKey(runId, "graph-packages", attempt),
      });
      jobId = job.id;
      this.trackChild(activeRun, "graph_packages", jobId);
      signal.throwIfAborted();
      await this.dependencies.repository.attachJob(scope, runId, "graph_packages", jobId);
      signal.throwIfAborted();
      await this.dependencies.repository.updateSource(scope, runId, "graph_packages", {
        status: "waiting_authorization",
        jobId,
        count: job.observedCount,
        message: "Waiting for delegated authorization to collect the agent list and matching identities.",
        canRetry: true,
      });
      signal.throwIfAborted();
      const started = job.status === "waiting_authorization"
        ? await this.dependencies.packages.start(user, job.id, "delegated", { retryFailed })
        : job;
      signal.throwIfAborted();
      await this.trackPackageJob(user, scope, runId, started, signal);
    } catch (error) {
      if (jobId) await this.cleanupTrackedChildren(activeRun, new Set([childKey("graph_packages", jobId)]));
      await this.handleSourceFailure(scope, runId, "graph_packages", jobId, error);
    }
  }

  private async runPowerPlatform(user: AuthenticatedUser, scope: DataSyncScope, runId: string, signal: AbortSignal, activeRun: ActiveRun, retryFailed: boolean) {
    let jobId: string | null = null;
    try {
      signal.throwIfAborted();
      const attempt = await this.dependencies.repository.getSourceAttempt(scope, runId, "power_platform");
      signal.throwIfAborted();
      const job = await this.dependencies.powerPlatform.submit(user, {
        idempotencyKey: childIdempotencyKey(runId, "power-platform", attempt),
        requestedTypes: powerPlatformResourceTypes,
      });
      jobId = job.id;
      this.trackChild(activeRun, "power_platform", jobId);
      signal.throwIfAborted();
      await this.dependencies.repository.attachJob(scope, runId, "power_platform", jobId);
      signal.throwIfAborted();
      await this.dependencies.repository.updateSource(scope, runId, "power_platform", {
        status: "waiting_authorization",
        jobId,
        count: job.observedCount,
        message: "Waiting for explicit delegated authorization to read Power Platform agents and non-agent resources.",
        canRetry: true,
      });
      signal.throwIfAborted();
      const started = job.status === "waiting_authorization"
        ? await this.dependencies.powerPlatform.start(user, job.id, { retryFailed })
        : job;
      signal.throwIfAborted();
      await this.trackPowerPlatformJob(user, scope, runId, started, signal);
    } catch (error) {
      if (jobId) await this.cleanupTrackedChildren(activeRun, new Set([childKey("power_platform", jobId)]));
      await this.handleSourceFailure(scope, runId, "power_platform", jobId, error);
    }
  }

  private async trackPackageJob(
    user: AuthenticatedUser,
    scope: DataSyncScope,
    runId: string,
    initial: PackageJob,
    signal: AbortSignal,
  ) {
    let job = initial;
    while (job.status === "running") {
      await this.reconcilePackageJob(scope, runId, job);
      await this.dependencies.wait(childPollIntervalMs, signal);
      job = await this.dependencies.packages.get(user, job.id, "delegated");
    }
    await this.reconcilePackageJob(scope, runId, job);
  }

  private async trackPowerPlatformJob(
    user: AuthenticatedUser,
    scope: DataSyncScope,
    runId: string,
    initial: PowerPlatformJob,
    signal: AbortSignal,
  ) {
    let job = initial;
    while (job.status === "running") {
      await this.reconcilePowerPlatformJob(scope, runId, job);
      await this.dependencies.wait(childPollIntervalMs, signal);
      job = await this.dependencies.powerPlatform.get(user, job.id);
    }
    await this.reconcilePowerPlatformJob(scope, runId, job);
  }

  private reconcilePackageJob(scope: DataSyncScope, runId: string, job: PackageJob) {
    if (job.errorCode === "data_sync_cleanup") return;
    return this.dependencies.repository.updateSource(scope, runId, "graph_packages", childSourceUpdate(
      "Graph package",
      job,
    ));
  }

  private reconcilePowerPlatformJob(scope: DataSyncScope, runId: string, job: PowerPlatformJob) {
    if (job.errorCode === "data_sync_cleanup") return;
    return this.dependencies.repository.updateSource(scope, runId, "power_platform", childSourceUpdate(
      "Power Platform",
      job,
    ));
  }

  private async handleSourceFailure(
    scope: DataSyncScope,
    runId: string,
    source: Exclude<DataSyncSourceId, "usage_reports">,
    jobId: string | null,
    error: unknown,
  ) {
    const cancelled = error instanceof AppError && error.code === "read_job_cancelled";
    operationalLog(cancelled ? "info" : "warn", "data_sync_source_failed", {
      runId, jobId, source, ...errorTelemetry(error),
    });
    await this.dependencies.repository.updateSource(scope, runId, source, {
      status: cancelled ? "cancelled" : authorizationStatus(error),
      jobId,
      message: cancelled ? "Cancelled by the requesting principal." : safeSyncFailure(error),
      canRetry: true,
    });
  }

  private async reconcileRun(
    user: AuthenticatedUser,
    scope: DataSyncScope,
    run: DataSyncRun,
    published: PublishedOfficialUsage,
  ) {
    run = await this.reconcileUsage(scope, run, published);
    // The local worker owns child progress and failure cleanup until it settles.
    if (this.active.has(run.id)) return run;
    for (const source of run.sources) {
      if (!source.jobId || !["queued", "running", "waiting_authorization"].includes(source.status)) continue;
      if (source.source === "graph_packages") {
        try {
          const job = await this.dependencies.packages.get(user, source.jobId, "delegated");
          await this.reconcilePackageJob(scope, run.id, job);
        } catch (error) {
          if (!(error instanceof AppError) || error.status !== 404) throw error;
          await this.dependencies.repository.updateSource(scope, run.id, source.source, {
            status: "failed",
            jobId: source.jobId,
            message: "The retained Graph package child job is no longer available.",
            canRetry: true,
          });
        }
      }
      if (source.source === "power_platform") {
        try {
          const job = await this.dependencies.powerPlatform.get(user, source.jobId);
          await this.reconcilePowerPlatformJob(scope, run.id, job);
        } catch (error) {
          if (!(error instanceof AppError) || error.status !== 404) throw error;
          await this.dependencies.repository.updateSource(scope, run.id, source.source, {
            status: "failed",
            jobId: source.jobId,
            message: "The retained Power Platform child job is no longer available.",
            canRetry: true,
          });
        }
      }
    }
    return (await this.dependencies.repository.getRun(scope, run.id)) ?? run;
  }

  private async reconcileUsage(scope: DataSyncScope, run: DataSyncRun, published?: PublishedOfficialUsage) {
    if (run.status === "cancelled") return run;
    const source = run.sources.find(value => value.source === "usage_reports");
    if (!source || source.status === "succeeded") return run;
    const current = published ?? await this.dependencies.officialUsage.getPublished(scope.tenantId);
    if (hasAcceptedUsage(current)) {
      await this.dependencies.repository.updateSource(scope, run.id, "usage_reports", {
        status: "succeeded",
        count: usageRowCount(current),
        lastSuccessAt: usageAcceptedAt(current),
        message: "A complete accepted three-CSV Microsoft admin-center usage bundle is available.",
        canRetry: false,
      });
    } else {
      await this.dependencies.repository.updateSource(scope, run.id, "usage_reports", {
        status: "awaiting_upload",
        count: null,
        message: "requiresAdmin: An AgentControl.Admin must download and import the three official Microsoft admin-center usage CSV reports.",
        canRetry: false,
      });
    }
    return (await this.dependencies.repository.getRun(scope, run.id)) ?? run;
  }

  private trackChild(tracker: ActiveRun, source: TrackedChild["source"], jobId: string) {
    tracker.children.set(childKey(source, jobId), { source, jobId });
  }

  private trackPersistedChildren(tracker: ActiveRun, run: DataSyncRun) {
    for (const source of run.sources) {
      if (!source.jobId || source.status === "succeeded") continue;
      if (source.source === "graph_packages" || source.source === "power_platform") {
        this.trackChild(tracker, source.source, source.jobId);
      }
    }
  }

  private async cleanupTrackedChildren(tracker: ActiveRun, selectedKeys?: ReadonlySet<string>) {
    const children = [...tracker.children.entries()].filter(([key]) => !selectedKeys || selectedKeys.has(key));
    await Promise.all(children.map(async ([key, child]) => {
      try {
        const reason = tracker.controller.signal.reason;
        await this.cancelChild(tracker.user, child, !(reason instanceof AppError && reason.code === "read_job_cancelled"));
        tracker.cleanupFailures.delete(key);
      } catch (error) {
        tracker.cleanupFailures.set(key, error);
        operationalLog("warn", "data_sync_child_cancel_failed", {
          source: child.source,
          count: 1,
          ...errorTelemetry(error),
        });
      }
    }));
  }

  private throwIfCleanupFailed(runId: string, tracker: ActiveRun) {
    if (!tracker.cleanupFailures.size) return;
    throw new AppError(
      502,
      "data_sync_child_cleanup_failed",
      "The data sync stopped, but one or more child jobs could not be confirmed cancelled.",
      { runId, childJobCount: tracker.cleanupFailures.size },
    );
  }

  private async cancelChildJobs(user: AuthenticatedUser, run: DataSyncRun, selectedSources?: readonly DataSyncSourceId[]) {
    const operations: Promise<unknown>[] = [];
    for (const source of run.sources) {
      if (!source.jobId || source.status === "succeeded" || (selectedSources && !selectedSources.includes(source.source))) continue;
      if (source.source === "graph_packages" || source.source === "power_platform") {
        operations.push(this.cancelChild(user, { source: source.source, jobId: source.jobId }, true));
      }
    }
    const results = await Promise.allSettled(operations);
    return results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map(result => result.reason);
  }

  private async cancelChild(user: AuthenticatedUser, child: TrackedChild, cleanup = false) {
    try {
      if (child.source === "graph_packages") {
        if (cleanup) await this.dependencies.packages.cancel(user, child.jobId, "delegated", "sync_cleanup");
        else await this.dependencies.packages.cancel(user, child.jobId, "delegated");
      } else {
        if (cleanup) await this.dependencies.powerPlatform.cancel(user, child.jobId, "sync_cleanup");
        else await this.dependencies.powerPlatform.cancel(user, child.jobId);
      }
    } catch (error) {
      if (!(error instanceof AppError) || error.status !== 404) throw error;
      operationalLog("info", "data_sync_child_unavailable", { source: child.source, count: 1 });
    }
  }
}

function defaultDependencies(database: pg.Pool): DataSyncDependencies {
  return {
    repository: new DataSyncRepository(database),
    officialUsage: new OfficialUsageRepository(database),
    packages: packageInventory,
    powerPlatform: powerPlatformInventory,
    copilotUsage: new CopilotUsageService(database),
    agentPeople: new AgentPeopleService(database),
    wait: waitFor,
  };
}

export const dataSync = new DataSyncService();

function dataScope(user: AuthenticatedUser): DataSyncScope {
  if (!user.tenantId) throw AppError.unauthorized("Data sync requires a tenant-scoped session.");
  return { tenantId: user.tenantId, principalId: user.homeAccountId };
}

function requireViewer(user: AuthenticatedUser) {
  if (!hasAppRole(user.roles, "AgentControl.Viewer")) {
    throw new AppError(403, "missing_internal_role", "Data sync requires Viewer.");
  }
}

function validateRunId(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new AppError(400, "invalid_data_sync_run", "Data sync run ID is invalid.");
  }
}

function executableSource(source: DataSyncSourceStatus) {
  return source.source !== "usage_reports" && source.status === "queued";
}

function userSourceUpdate(jobId: string, result: CopilotUsageRefreshResult) {
  return {
    status: result.status,
    jobId,
    count: result.count,
    message: result.message,
    canRetry: result.status !== "succeeded",
  };
}

function childSourceUpdate(label: string, job: PackageJob | PowerPlatformJob) {
  if (job.status === "succeeded") {
    const count = job.totalRecords ?? job.observedCount;
    return {
      status: "succeeded" as const,
      jobId: job.id,
      count,
      lastSuccessAt: job.finishedAt ?? job.updatedAt,
      message: `${label} saved snapshot completed with ${count} records.`,
      canRetry: false,
    };
  }
  if (job.status === "running") {
    return {
      status: "running" as const,
      jobId: job.id,
      count: job.observedCount,
      message: job.message ?? `${label} source is running (${job.observedCount} records observed).`,
      canRetry: false,
    };
  }
  if (job.status === "waiting_authorization") {
    return {
      status: "waiting_authorization" as const,
      jobId: job.id,
      count: job.observedCount,
      message: job.message ?? `${label} source requires explicit current authorization.`,
      canRetry: true,
    };
  }
  if (job.status === "cancelled") {
    return {
      status: "cancelled" as const,
      jobId: job.id,
      count: job.observedCount,
      message: job.message ?? `${label} source was cancelled.`,
      canRetry: true,
    };
  }
  return {
    status: "failed" as const,
    jobId: job.id,
    count: job.observedCount,
    message: job.message ?? `${label} source failed before complete publication.`,
    canRetry: true,
  };
}

function authorizationStatus(error: unknown): Extract<DataSyncSourceStatus["status"], "waiting_authorization" | "permission_required" | "failed"> {
  if (error instanceof AppError && (error.status === 401 || ["interaction_required", "authorization_expired", "unauthorized"].includes(error.code))) {
    return "waiting_authorization";
  }
  if (error instanceof AppError && (error.status === 403 || ["missing_permission", "missing_internal_role", "capability_unavailable", "not_configured"].includes(error.code))) {
    return "permission_required";
  }
  return "failed";
}

function safeSyncFailure(error: unknown) {
  const status = authorizationStatus(error);
  if (status === "waiting_authorization") return "Explicit resume with renewed Microsoft authorization is required.";
  if (status === "permission_required") return "Required delegated Microsoft read permission or provider role is unavailable.";
  if (error instanceof AppError && [
    "provider_error", "provider_timeout", "provider_throttled", "provider_schema", "provider_result_limit",
    "provider_response_size_limit", "provider_count_mismatch", "report_download_failed",
  ].includes(error.code)) return error.message.slice(0, 1024);
  return "The source failed before complete saved-data publication.";
}

function hasAcceptedUsage(published: PublishedOfficialUsage) {
  return published.activeSet?.complete === true && Object.keys(published.reports).length === 3;
}

function usageRowCount(published: PublishedOfficialUsage) {
  return Object.values(published.reports).reduce((count, report) => count + (report?.rows.length ?? 0), 0);
}

function usageAcceptedAt(published: PublishedOfficialUsage) {
  return published.activeSet?.acceptedAt
    ?? Object.values(published.reports).map(report => report?.lineage.acceptedAt).filter((value): value is string => Boolean(value)).sort().at(-1)
    ?? new Date().toISOString();
}

function reconcileUsageMarker(sources: DataSyncSourceStatus[], published: PublishedOfficialUsage) {
  if (!hasAcceptedUsage(published)) return sources.map(source => source.source === "usage_reports" ? {
    source: source.source,
    status: "not_started" as const,
    jobId: null,
    count: null,
    lastSuccessAt: null,
    updatedAt: null,
    message: "No complete accepted three-CSV Microsoft admin-center usage bundle is currently available.",
    canRetry: false,
  } : source);
  return sources.map(source => source.source === "usage_reports" ? {
    ...source,
    status: "succeeded" as const,
    count: usageRowCount(published),
    lastSuccessAt: usageAcceptedAt(published),
    message: "A complete accepted three-CSV Microsoft admin-center usage bundle is available.",
    canRetry: false,
  } : source);
}

function childTracker(runId: string, scope: DataSyncScope, user: AuthenticatedUser): ActiveRun {
  return {
    runId,
    scope,
    user,
    controller: new AbortController(),
    operation: Promise.resolve(),
    children: new Map(),
    cleanupFailures: new Map(),
  };
}

function childKey(source: TrackedChild["source"], jobId: string) {
  return `${source}\0${jobId}`;
}

function childIdempotencyKey(runId: string, source: string, attempt: number) {
  return `data-sync-${source}-${runId}-${attempt}`.slice(0, 128);
}

function waitFor(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timeout = setTimeout(done, milliseconds);
    timeout.unref();
    const aborted = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", aborted);
      reject(signal.reason);
    };
    signal.addEventListener("abort", aborted, { once: true });
    function done() {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
  });
}
