import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataSyncRepository } from "../db/dataSync.js";
import { pool } from "../db/pool.js";
import { AppError } from "../errors.js";
import type { DataSyncRun } from "../types/dataSync.js";
import type { AuthenticatedUser } from "../types/session.js";
import { DataSyncService } from "./dataSync.js";
import type { AgentSharingDiagnosticContext } from "./temporaryAgentSharingDiagnostic.js";
import type { CopilotUsageService } from "./copilotUsage.js";
import type { AgentPeopleService } from "./agentPeople.js";
import type { PackageInventoryService } from "./packageInventory.js";
import type { PowerPlatformInventoryService } from "./powerPlatformInventory.js";
import * as operationalState from "./operationalState.js";

vi.mock("../db/pool.js", () => ({
  pool: { options: { max: 4 },
    query: vi.fn(async () => { throw new Error("Unit tests must not query a database."); }),
    connect: vi.fn(async () => { throw new Error("Unit tests must not open a database connection."); }),
  },
  secretValue: vi.fn((name: string) => name === "SESSION_SECRET" ? "synthetic-sync-admission-session-secret" : undefined),
  transaction: vi.fn(async () => { throw new Error("Unit tests must not access a database."); }),
}));

beforeEach(async () => {
  await operationalState.loadOperationalState({ query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [{
    mode: "normal",
  }] }) });
});
afterEach(() => vi.restoreAllMocks());

describe("data sync admission ownership", () => {
  it.each(["submit", "automatic", "retry"] as const)("fences %s before its durable transaction can commit", async operation => {
    const f = fixture();
    let closed = false, committed = false;
    vi.spyOn(operationalState, "requireProviderAdmissions").mockImplementation(() => {
      if (closed) throw new AppError(503, "maintenance", "Provider admissions closed.");
    });
    const commit = (fence?: () => void) => {
      closed = true;
      fence?.();
      committed = true;
    };
    vi.spyOn(f.repository, "submit").mockImplementation(async (_scope, _input, fence) => {
      commit(fence);
      return { run: f.run, created: true };
    });
    vi.spyOn(f.repository, "submitDue").mockImplementation(async (_scope, _signedInAt, fence) => {
      commit(fence);
      return { run: f.run, created: true };
    });
    vi.spyOn(f.repository, "retry").mockImplementation(async (_scope, _id, _sources, fence) => {
      commit(fence);
      return ["users"];
    });
    try {
      const request = operation === "submit" ? f.service.start(f.user, { mode: "full", clearSavedData: true })
        : operation === "automatic" ? f.service.automaticRefresh(f.user) : f.service.retry(f.user, f.run.id, ["users"]);
      await expect(request).rejects.toMatchObject({ code: "maintenance" });
      expect(committed).toBe(false);
      expect(f.repository.pausePrincipal).not.toHaveBeenCalled();
      expect(f.packages.submit).not.toHaveBeenCalled();
      expect(f.powerPlatform.submit).not.toHaveBeenCalled();
      expect(f.copilotUsage.refreshUsers).not.toHaveBeenCalled();
    } finally { await f.service.drain(); }
  });

  it("finishes every bounded restart batch without dispatching provider work", async () => {
    const f = fixture();
    const recovered = vi.spyOn(f.repository, "recoverInterrupted")
      .mockResolvedValueOnce(1000).mockResolvedValueOnce(25).mockResolvedValueOnce(0);
    try {
      await expect(f.service.recover()).resolves.toBe(1025);
      expect(recovered).toHaveBeenCalledTimes(3);
      expect(f.packages.submit).not.toHaveBeenCalled();
      expect(f.powerPlatform.submit).not.toHaveBeenCalled();
      expect(f.copilotUsage.refreshUsers).not.toHaveBeenCalled();
    } finally { await f.service.drain(); }
  });

  it.each([0, 1])("stops restart recovery after %s batches when operational admissions close", async batches => {
    const f = fixture();
    const recovered = vi.spyOn(f.repository, "recoverInterrupted").mockResolvedValue(1000);
    const admissionsOpen = vi.fn(async () => recovered.mock.calls.length < batches);
    try {
      await expect(f.service.recover(admissionsOpen)).resolves.toBe(1000 * batches);
      expect(recovered).toHaveBeenCalledTimes(batches);
      expect(f.packages.submit).not.toHaveBeenCalled();
      expect(f.powerPlatform.submit).not.toHaveBeenCalled();
    } finally { await f.service.drain(); }
  });

  it("propagates a failed restart admission read without starting another batch", async () => {
    const f = fixture();
    const recovered = vi.spyOn(f.repository, "recoverInterrupted").mockResolvedValue(1000);
    const admissionsOpen = vi.fn().mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("State unavailable"));
    try {
      await expect(f.service.recover(admissionsOpen)).rejects.toThrow("State unavailable");
      expect(recovered).toHaveBeenCalledOnce();
    } finally { await f.service.drain(); }
  });

  it.each((["graph_packages", "power_platform"] as const).flatMap(source =>
    (["cancelled", "expired"] as const).map(stopped => ({ source, stopped })),
  ))("does not dispatch a $source child when its durable handoff is $stopped", async ({ source, stopped }) => {
    const f = fixture();
    Object.assign(f.run, { status: "running", completedAt: null });
    Object.assign(f.run.sources[0], { source, status: "queued", canRetry: false });
    const jobId = randomUUID(), now = new Date().toISOString();
    const common = {
      id: jobId, status: "waiting_authorization" as const, pageCount: 0, observedCount: 0,
      totalRecords: null, snapshotId: null, createdAt: now, attemptedAt: null, updatedAt: now, finishedAt: null,
    };
    const packageJob = { ...common, authorizationPrincipalId: f.user.homeAccountId, tokenMode: "delegated" as const,
      scopeKind: "broad" as const, requestedIds: [], targetCount: 0, resultRevision: now, autoDetails: false };
    const nativeJob = { ...common, roleScope: "full" as const, environmentScope: null, requestedTypes: [], unknownFieldCount: 0 };
    f.packages.submit.mockResolvedValue(packageJob);
    f.packages.cancel.mockResolvedValue({ ...packageJob, status: "cancelled" });
    f.powerPlatform.submit.mockResolvedValue(nativeJob);
    f.powerPlatform.cancel.mockResolvedValue({ ...nativeJob, status: "cancelled" });
    vi.spyOn(f.repository, "submit").mockResolvedValue({ run: f.run, created: true });
    vi.spyOn(f.repository, "getSourceAttempt").mockResolvedValue(1);
    vi.spyOn(f.repository, "attachJob").mockImplementation(async (_scope, _runId, _source, id, fence) => {
      fence?.();
      f.run.sources[0].jobId = id;
    });
    vi.spyOn(f.repository, "updateSource").mockResolvedValue(f.run).mockImplementationOnce(async (_scope, _id, _source, _update, fence) => {
      fence?.();
      if (stopped === "expired") return undefined;
      f.run.status = "cancelled";
      f.run.sources[0].status = "cancelled";
      return f.run;
    });
    const provider = source === "graph_packages" ? f.packages : f.powerPlatform;
    try {
      await f.service.start(f.user, { mode: "incremental", sources: [source] });
      await vi.waitFor(() => expect(provider.cancel).toHaveBeenCalled());
      expect(provider.start).not.toHaveBeenCalled();
      expect(f.copilotUsage.refreshUsers).not.toHaveBeenCalled();
    } finally { await f.service.drain(); }
  });
});

describe("temporary sharing diagnostic sync hook", () => {
  it.each(["manual", "automatic", "failed", "diagnostic-failed"] as const)("preserves normal sync behavior for %s runs", async mode => {
    const sharingDiagnostic = vi.fn<(user: AuthenticatedUser, context: AgentSharingDiagnosticContext) => Promise<unknown>>(async () => {
      if (mode === "diagnostic-failed") throw new AppError(507, "diagnostic_capture_limit", "Capture quota reached.");
    });
    const f = fixture(sharingDiagnostic);
    const now = new Date().toISOString();
    Object.assign(f.run, { status: "running", completedAt: null, automatic: mode === "automatic" });
    Object.assign(f.run.sources[0], { source: "graph_packages", status: "queued", canRetry: false });
    const job = {
      id: randomUUID(), status: mode === "failed" ? "failed" as const : "succeeded" as const,
      authorizationPrincipalId: f.user.homeAccountId, tokenMode: "delegated" as const,
      scopeKind: "broad" as const, requestedIds: [], targetCount: 0, resultRevision: now, autoDetails: false,
      pageCount: 1, observedCount: 2, totalRecords: 2, snapshotId: randomUUID(),
      createdAt: now, attemptedAt: now, updatedAt: now, finishedAt: now,
    };
    f.packages.submit.mockResolvedValue(job);
    f.packages.cancel.mockResolvedValue({ ...job, status: "cancelled" });
    f.packages.startDetailSync.mockResolvedValue({ status: "complete", total: 2, fresh: 2, pending: 0, eligible: 0, message: "Complete", job: null });
    f.packages.refreshDueDetails.mockResolvedValue(undefined);
    vi.spyOn(f.repository, "submit").mockResolvedValue({ run: f.run, created: true });
    vi.spyOn(f.repository, "submitDue").mockResolvedValue({ run: f.run, created: true });
    vi.spyOn(f.repository, "automaticRevisions").mockResolvedValue({ users: "1", graph_packages: "1", power_platform: "1" });
    vi.spyOn(f.repository, "finishAutomatic").mockResolvedValue(undefined);
    vi.spyOn(f.repository, "getSourceAttempt").mockResolvedValue(1);
    vi.spyOn(f.repository, "attachJob").mockResolvedValue(undefined);
    vi.spyOn(f.repository, "updateSource").mockImplementation(async (_scope, _id, _source, update, beforeCommit) => {
      beforeCommit?.();
      Object.assign(f.run.sources[0], update);
      return f.run;
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      if (mode === "automatic") await f.service.automaticRefresh(f.user);
      else await f.service.start(f.user, { mode: "incremental", sources: ["graph_packages"] });
      await vi.waitFor(() => {
        expect(f.run.sources[0].status).toBe(mode === "failed" ? "failed" : "succeeded");
        if (mode === "manual" || mode === "diagnostic-failed") expect(sharingDiagnostic).toHaveBeenCalledOnce();
        if (mode === "automatic") expect(f.repository.finishAutomatic).toHaveBeenCalledOnce();
      });
      await f.service.drain();
      expect(sharingDiagnostic).toHaveBeenCalledTimes(mode === "manual" || mode === "diagnostic-failed" ? 1 : 0);
      expect(f.packages.startDetailSync).toHaveBeenCalledTimes(mode === "failed" ? 0 : 1);
      expect(f.run.sources[0].status).toBe(mode === "failed" ? "failed" : "succeeded");
      if (mode === "diagnostic-failed") expect(JSON.stringify(logged.mock.calls)).toContain("diagnostic_capture_limit");
      if (mode === "manual") {
        const context = sharingDiagnostic.mock.calls[0];
        expect(context).toEqual([f.user, expect.objectContaining({ runId: f.run.id, signal: expect.any(AbortSignal), assertCurrent: expect.any(Function) })]);
      }
    } finally { await f.service.drain(); }
  });
});

function fixture(sharingDiagnostic?: (user: AuthenticatedUser, context: AgentSharingDiagnosticContext) => Promise<unknown>) {
  const user: AuthenticatedUser = {
    tenantId: `synthetic-sync-${randomUUID()}`, homeAccountId: randomUUID(),
    username: "viewer@example.invalid", displayName: "Viewer", roles: ["AgentControl.Viewer"],
  };
  const now = new Date().toISOString();
  const run: DataSyncRun = {
    id: randomUUID(), mode: "full", status: "partial", startedAt: now, updatedAt: now, completedAt: now,
    sources: [{
      source: "users", status: "failed", jobId: null, count: null, lastSuccessAt: null,
      updatedAt: now, message: "Retry required.", canRetry: true,
    }],
  };
  const repository = new DataSyncRepository(pool);
  vi.spyOn(repository, "getRun").mockResolvedValue(run);
  vi.spyOn(repository, "getLatestRun").mockResolvedValue(undefined);
  vi.spyOn(repository, "pausePrincipal").mockResolvedValue(0);
  const forbidden = new Error("This test must not dispatch child or provider work.");
  const packages = {
    startDetailSync: vi.fn<PackageInventoryService["startDetailSync"]>().mockRejectedValue(forbidden),
    submit: vi.fn<PackageInventoryService["submit"]>().mockRejectedValue(forbidden),
    start: vi.fn<PackageInventoryService["start"]>().mockRejectedValue(forbidden),
    get: vi.fn<PackageInventoryService["get"]>().mockRejectedValue(forbidden),
    cancel: vi.fn<PackageInventoryService["cancel"]>().mockRejectedValue(forbidden),
    waitForPrincipalAuthorization: vi.fn<PackageInventoryService["waitForPrincipalAuthorization"]>().mockResolvedValue(undefined),
    refreshDueDetails: vi.fn<PackageInventoryService["refreshDueDetails"]>().mockRejectedValue(forbidden),
  };
  const powerPlatform = {
    submit: vi.fn<PowerPlatformInventoryService["submit"]>().mockRejectedValue(forbidden),
    start: vi.fn<PowerPlatformInventoryService["start"]>().mockRejectedValue(forbidden),
    get: vi.fn<PowerPlatformInventoryService["get"]>().mockRejectedValue(forbidden),
    cancel: vi.fn<PowerPlatformInventoryService["cancel"]>().mockRejectedValue(forbidden),
    waitForPrincipalAuthorization: vi.fn<PowerPlatformInventoryService["waitForPrincipalAuthorization"]>().mockResolvedValue(undefined),
  };
  const copilotUsage = { refreshUsers: vi.fn<CopilotUsageService["refreshUsers"]>().mockRejectedValue(forbidden) };
  const agentPeople = { refreshReferences: vi.fn<AgentPeopleService["refreshReferences"]>().mockRejectedValue(forbidden) };
  const service = new DataSyncService(pool, {
    repository, packages, powerPlatform, copilotUsage, agentPeople,
    officialUsage: { read: vi.fn(async () => ({ complete: false, count: 0, acceptedAt: null })) },
    wait: vi.fn(async () => undefined),
    sharingDiagnostic,
  });
  return { service, repository, user, run, packages, powerPlatform, copilotUsage };
}
