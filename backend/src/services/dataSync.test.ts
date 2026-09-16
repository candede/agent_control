import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import type { DataSyncRun, DataSyncSourceId, DataSyncSourceStatus } from "../types/dataSync.js";
import type { AuthenticatedUser } from "../types/session.js";
import { DataSyncService } from "./dataSync.js";

const user: AuthenticatedUser = {
  tenantId: "tenant-data-sync",
  homeAccountId: "viewer-data-sync",
  username: "viewer@example.com",
  displayName: "Viewer",
  roles: ["AgentControl.Viewer"],
};

describe("DataSyncService", () => {
  it("exposes bounded principal-scoped runs for the shared Jobs view", async () => {
    const harness = serviceHarness();
    const scope = { tenantId: user.tenantId!, principalId: user.homeAccountId };
    expect(await harness.service.listRuns(scope, 12)).toEqual([harness.run]);
    expect(harness.repository.listRuns).toHaveBeenCalledWith(scope, 12);
    expect(await harness.service.getRun(scope, harness.run.id)).toBe(harness.run);
    expect(harness.repository.getRun).toHaveBeenCalledWith(scope, harness.run.id);
  });

  it("starts broad delegated core sources, includes non-agent Power Platform types, and waits for required uploads", async () => {
    const harness = serviceHarness();
    const started = await harness.service.start(user, { mode: "initial" });
    expect(started.sources.find(source => source.source === "usage_reports")).toMatchObject({
      status: "awaiting_upload",
      canRetry: false,
      message: expect.stringContaining("requiresAdmin"),
    });
    await vi.waitFor(() => {
      expect(harness.packages.submit).toHaveBeenCalled();
      expect(harness.powerPlatform.submit).toHaveBeenCalled();
      expect(harness.copilotUsage.refreshUsers).toHaveBeenCalled();
    });
    expect(harness.packages.submit).toHaveBeenCalledWith(user, expect.objectContaining({
      tokenMode: "delegated",
      requestedIds: [],
    }));
    expect(harness.powerPlatform.submit).toHaveBeenCalledWith(user, expect.objectContaining({
      requestedTypes: expect.arrayContaining([
        "microsoft.copilotstudio/agents",
        "microsoft.powerapps/canvasapps",
        "microsoft.powerautomate/cloudflows",
      ]),
    }));
    expect(harness.copilotUsage.refreshUsers).toHaveBeenCalledWith(user, expect.any(AbortSignal), {
      incompleteOnly: false,
      publication: { runId: harness.run.id, jobId: expect.any(String) },
    });
  });

  it("passes the clean full opt-in through admission while retaining accepted official usage", async () => {
    const harness = serviceHarness();
    harness.officialUsage.getPublished.mockResolvedValue(acceptedUsage() as never);
    const started = await harness.service.start(user, { mode: "full", clearSavedData: true });
    expect(harness.repository.submit).toHaveBeenCalledWith({
      tenantId: user.tenantId, principalId: user.homeAccountId,
    }, { mode: "full", clearSavedData: true });
    expect(started.sources.find(source => source.source === "usage_reports")).toMatchObject({
      status: "succeeded", count: 3, canRetry: false,
    });
    await vi.waitFor(() => expect(harness.copilotUsage.refreshUsers).toHaveBeenCalled());
  });

  it("reconciles child progress on state reads without starting or submitting provider work", async () => {
    const harness = serviceHarness();
    const graph = harness.run.sources.find(source => source.source === "graph_packages")!;
    graph.status = "running";
    graph.jobId = randomUUID();
    harness.packages.get.mockResolvedValue(packageJob(graph.jobId, "succeeded", 0));
    const state = await harness.service.state(user);
    expect(state.sources.find(source => source.source === "graph_packages")).toMatchObject({
      status: "succeeded",
      count: 0,
    });
    expect(harness.packages.get).toHaveBeenCalledTimes(1);
    expect(harness.packages.submit).not.toHaveBeenCalled();
    expect(harness.packages.start).not.toHaveBeenCalled();
    expect(harness.powerPlatform.submit).not.toHaveBeenCalled();
  });

  it("lets an existing complete accepted three-report bundle satisfy a nondestructive resync", async () => {
    const harness = serviceHarness();
    harness.officialUsage.getPublished.mockResolvedValue(acceptedUsage() as never);
    const started = await harness.service.start(user, { mode: "full", sources: ["usage_reports"] });
    expect(started.sources).toEqual([
      expect.objectContaining({
        source: "usage_reports",
        status: "succeeded",
        count: 3,
        canRetry: false,
      }),
    ]);
  });

  it("reconciles an accepted upload when polling an exact run without first loading global state", async () => {
    const harness = serviceHarness();
    harness.run.sources = [harness.run.sources.find(source => source.source === "usage_reports")!];
    harness.run.sources[0].status = "awaiting_upload";
    harness.run.status = "waiting";
    harness.officialUsage.getPublished.mockResolvedValue(acceptedUsage() as never);
    const exact = await harness.service.getRun(
      { tenantId: user.tenantId!, principalId: user.homeAccountId },
      harness.run.id,
    );
    expect(exact.sources[0]).toMatchObject({
      source: "usage_reports",
      status: "succeeded",
      count: 3,
    });
    expect(harness.repository.getLatestRun).not.toHaveBeenCalled();
    expect(harness.packages.get).not.toHaveBeenCalled();
    expect(harness.powerPlatform.get).not.toHaveBeenCalled();
  });

  it("keeps a cancelled historical run immutable when later usage is accepted", async () => {
    const harness = serviceHarness();
    harness.run.sources = [harness.run.sources.find(source => source.source === "usage_reports")!];
    harness.run.sources[0].status = "cancelled";
    harness.run.status = "cancelled";
    harness.officialUsage.getPublished.mockResolvedValue(acceptedUsage() as never);
    const exact = await harness.service.getRun(
      { tenantId: user.tenantId!, principalId: user.homeAccountId },
      harness.run.id,
    );
    expect(exact).toMatchObject({
      status: "cancelled",
      sources: [{ source: "usage_reports", status: "cancelled" }],
    });
    expect(harness.officialUsage.getPublished).not.toHaveBeenCalled();
    expect(harness.repository.updateSource).not.toHaveBeenCalled();
  });

  it("cancels associated child work and pauses all active authorization on sign-out", async () => {
    const harness = serviceHarness();
    const graph = harness.run.sources.find(source => source.source === "graph_packages")!;
    graph.status = "running";
    graph.jobId = randomUUID();
    harness.repository.cancel.mockImplementation(async () => {
      harness.run.status = "cancelled";
      return harness.run;
    });
    await harness.service.cancel(user, harness.run.id);
    expect(harness.packages.cancel).toHaveBeenCalledWith(user, graph.jobId, "delegated");
    await harness.service.waitForPrincipalAuthorization({ tenantId: user.tenantId!, principalId: user.homeAccountId });
    expect(harness.packages.waitForPrincipalAuthorization).toHaveBeenCalled();
    expect(harness.powerPlatform.waitForPrincipalAuthorization).toHaveBeenCalled();
    expect(harness.repository.pausePrincipal).toHaveBeenCalled();
  });

  it("cancels the prior waiting child before launching a retry attempt", async () => {
    const harness = serviceHarness();
    const graph = harness.run.sources.find(source => source.source === "graph_packages")!;
    graph.status = "permission_required";
    graph.canRetry = true;
    graph.jobId = randomUUID();
    harness.repository.retry.mockImplementation(async () => {
      graph.status = "queued";
      graph.jobId = null;
      return ["graph_packages"];
    });
    await harness.service.retry(user, harness.run.id, ["graph_packages"]);
    expect(harness.packages.cancel).toHaveBeenCalledWith(user, expect.any(String), "delegated");
    await vi.waitFor(() => expect(harness.packages.submit).toHaveBeenCalled());
  });

  it.each(["graph_packages", "power_platform"] as const)(
    "cancels a %s child returned after parent cancellation without starting or losing it",
    async source => {
      const harness = serviceHarness();
      const submitted = deferred<ReturnType<typeof packageJob> | ReturnType<typeof powerPlatformJob>>();
      const provider = source === "graph_packages" ? harness.packages : harness.powerPlatform;
      provider.submit.mockImplementationOnce(() => submitted.promise as never);
      harness.repository.cancel.mockImplementation(async () => {
        harness.run.status = "cancelled";
        for (const value of harness.run.sources) value.status = "cancelled";
        return harness.run;
      });

      await harness.service.start(user, { mode: "incremental", sources: [source] });
      await vi.waitFor(() => expect(provider.submit).toHaveBeenCalledTimes(1));
      const cancellation = harness.service.cancel(user, harness.run.id);
      let settled = false;
      void cancellation.finally(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);

      const jobId = randomUUID();
      submitted.resolve(source === "graph_packages"
        ? packageJob(jobId, "waiting_authorization", 0)
        : powerPlatformJob(jobId, "waiting_authorization", 0));
      await cancellation;

      expect(provider.start).not.toHaveBeenCalled();
      expect(harness.repository.attachJob).not.toHaveBeenCalled();
      expect(provider.cancel).toHaveBeenCalledWith(
        user,
        jobId,
        ...(source === "graph_packages" ? ["delegated" as const] : []),
      );
    },
  );

  it.each([
    ["graph_packages", "getSourceAttempt"],
    ["graph_packages", "attachJob"],
    ["graph_packages", "updateSource"],
    ["power_platform", "getSourceAttempt"],
    ["power_platform", "attachJob"],
    ["power_platform", "updateSource"],
  ] as const)(
    "checks cancellation after the deferred %s %s boundary",
    async (source, boundary) => {
      const harness = serviceHarness();
      const gate = deferred<unknown>();
      const provider = source === "graph_packages" ? harness.packages : harness.powerPlatform;
      const boundaryMock = boundary === "getSourceAttempt"
        ? harness.repository.getSourceAttempt
        : boundary === "attachJob"
          ? harness.repository.attachJob
          : harness.repository.updateSource;
      boundaryMock.mockImplementationOnce(() => gate.promise as never);
      harness.repository.cancel.mockImplementation(async () => {
        harness.run.status = "cancelled";
        for (const value of harness.run.sources) value.status = "cancelled";
        return harness.run;
      });

      await harness.service.start(user, { mode: "incremental", sources: [source] });
      await vi.waitFor(() => expect(boundaryMock).toHaveBeenCalledTimes(1));
      const cancellation = harness.service.cancel(user, harness.run.id);
      let settled = false;
      void cancellation.finally(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);

      gate.resolve(boundary === "getSourceAttempt" ? 1 : boundary === "attachJob" ? undefined : harness.run);
      await cancellation;
      expect(provider.start).not.toHaveBeenCalled();
      if (boundary === "getSourceAttempt") {
        expect(provider.submit).not.toHaveBeenCalled();
        expect(provider.cancel).not.toHaveBeenCalled();
      } else {
        expect(provider.cancel).toHaveBeenCalled();
      }
    },
  );

  it.each(["graph_packages", "power_platform"] as const)(
    "waits for a pending %s native start during sign-out and cancels the created child",
    async source => {
      const harness = serviceHarness();
      const started = deferred<ReturnType<typeof packageJob> | ReturnType<typeof powerPlatformJob>>();
      const provider = source === "graph_packages" ? harness.packages : harness.powerPlatform;
      provider.start.mockImplementationOnce(() => started.promise as never);

      await harness.service.start(user, { mode: "incremental", sources: [source] });
      await vi.waitFor(() => expect(provider.start).toHaveBeenCalledTimes(1));
      const signOut = harness.service.waitForPrincipalAuthorization({
        tenantId: user.tenantId!,
        principalId: user.homeAccountId,
      });
      let settled = false;
      void signOut.finally(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);

      const jobId = provider.start.mock.calls[0][1] as string;
      started.resolve(source === "graph_packages"
        ? packageJob(jobId, "running", 0)
        : powerPlatformJob(jobId, "running", 0));
      await signOut;
      expect(provider.cancel).toHaveBeenCalledWith(
        user,
        jobId,
        ...(source === "graph_packages" ? ["delegated" as const] : []),
      );
    },
  );

  it("surfaces a child cleanup failure after cancellation instead of reporting clean cancellation", async () => {
    const harness = serviceHarness();
    const graph = harness.run.sources.find(source => source.source === "graph_packages")!;
    graph.status = "running";
    graph.jobId = randomUUID();
    harness.packages.cancel.mockRejectedValue(new Error("cleanup unavailable"));
    harness.repository.cancel.mockImplementation(async () => {
      harness.run.status = "cancelled";
      graph.status = "cancelled";
      return harness.run;
    });
    await expect(harness.service.cancel(user, harness.run.id)).rejects.toMatchObject({
      code: "data_sync_child_cleanup_failed",
      details: { childJobCount: 1 },
    });
  });
});

function serviceHarness() {
  const run = dataSyncRun();
  const markers = run.sources.map(source => ({ ...source, status: "not_started" as const, updatedAt: null }));
  const repository = {
    submit: vi.fn(async (_scope, input) => {
      const requested = new Set<DataSyncSourceId>(input.sources ?? ["users", "graph_packages", "power_platform", "usage_reports"]);
      if (input.mode === "initial" || input.mode === "full") requested.add("usage_reports");
      run.sources = run.sources.filter(source => requested.has(source.source));
      return { run, created: true };
    }),
    getRun: vi.fn(async () => run),
    getLatestRun: vi.fn(async () => run),
    listRuns: vi.fn(async () => [run]),
    getSourceAttempt: vi.fn(async () => 1),
    listMarkers: vi.fn(async () => markers),
    attachJob: vi.fn(async (_scope, _runId, source: DataSyncSourceId, jobId: string) => {
      run.sources.find(value => value.source === source)!.jobId = jobId;
    }),
    updateSource: vi.fn(async (_scope, _runId, source: DataSyncSourceId, update: Partial<DataSyncSourceStatus>) => {
      Object.assign(run.sources.find(value => value.source === source)!, update, { updatedAt: new Date().toISOString() });
      return run;
    }),
    recordSuccessMarker: vi.fn(),
    retry: vi.fn(async (_scope, _id, sources) => sources ?? []),
    cancel: vi.fn(async () => run),
    pausePrincipal: vi.fn(async () => 1),
    recoverInterrupted: vi.fn(async () => 0),
  };
  const packages = {
    submit: vi.fn(async () => packageJob(randomUUID(), "waiting_authorization", 0)),
    start: vi.fn(async (_user, id) => packageJob(id, "succeeded", 0)),
    get: vi.fn(async (_user, id) => packageJob(id, "succeeded", 0)),
    cancel: vi.fn(async (_user, id) => packageJob(id, "cancelled", 0)),
    waitForPrincipalAuthorization: vi.fn(async () => undefined),
  };
  const powerPlatform = {
    submit: vi.fn(async () => powerPlatformJob(randomUUID(), "waiting_authorization", 0)),
    start: vi.fn(async (_user, id) => powerPlatformJob(id, "succeeded", 0)),
    get: vi.fn(async (_user, id) => powerPlatformJob(id, "succeeded", 0)),
    cancel: vi.fn(async (_user, id) => powerPlatformJob(id, "cancelled", 0)),
    waitForPrincipalAuthorization: vi.fn(async () => undefined),
  };
  const copilotUsage = {
    refreshUsers: vi.fn(async () => ({
      status: "succeeded" as const,
      count: 0,
      message: "Saved normalized zero-row user sources.",
    })),
  };
  const officialUsage = {
    getPublished: vi.fn(async () => ({
      activeRevision: 1,
      activeSet: null,
      reports: {},
      retainedCompleteSets: 0,
      retainedIncompleteSets: 0,
      hasImportHistory: false,
      activeSelectionIncomplete: false,
    })),
  };
  const service = new DataSyncService({} as pg.Pool, {
    repository,
    packages,
    powerPlatform,
    copilotUsage,
    officialUsage,
    wait: vi.fn(async () => undefined),
  } as never);
  return { service, run, repository, packages, powerPlatform, copilotUsage, officialUsage };
}

function dataSyncRun(): DataSyncRun {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    mode: "initial",
    status: "running",
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    sources: (["users", "graph_packages", "power_platform", "usage_reports"] as const).map(source => ({
      source,
      status: "queued",
      jobId: null,
      count: null,
      lastSuccessAt: null,
      updatedAt: now,
      message: "Queued.",
      canRetry: false,
    })),
  };
}

function packageJob(id: string, status: "waiting_authorization" | "running" | "succeeded" | "failed" | "cancelled", count: number) {
  const now = new Date().toISOString();
  return {
    id,
    authorizationPrincipalId: user.homeAccountId,
    tokenMode: "delegated" as const,
    scopeKind: "broad" as const,
    requestedIds: [],
    status,
    pageCount: 1,
    observedCount: count,
    totalRecords: count,
    snapshotId: status === "succeeded" ? randomUUID() : null,
    createdAt: now,
    attemptedAt: now,
    updatedAt: now,
    finishedAt: ["succeeded", "failed", "cancelled"].includes(status) ? now : null,
  };
}

function powerPlatformJob(id: string, status: "waiting_authorization" | "running" | "succeeded" | "failed" | "cancelled", count: number) {
  const now = new Date().toISOString();
  return {
    id,
    status,
    roleScope: "full" as const,
    environmentScope: null,
    requestedTypes: [],
    pageCount: 1,
    observedCount: count,
    totalRecords: count,
    unknownFieldCount: 0,
    snapshotId: status === "succeeded" ? randomUUID() : null,
    createdAt: now,
    attemptedAt: now,
    updatedAt: now,
    finishedAt: ["succeeded", "failed", "cancelled"].includes(status) ? now : null,
  };
}

function acceptedUsage() {
  const acceptedAt = "2026-09-15T10:00:00.000Z";
  const report = (kind: "agents" | "userAgents" | "users") => ({
    kind,
    rows: [{}],
    lineage: { acceptedAt },
  });
  return {
    activeRevision: 2,
    activeSet: { complete: true, acceptedAt },
    reports: {
      agents: report("agents"),
      userAgents: report("userAgents"),
      users: report("users"),
    },
    retainedCompleteSets: 1,
    retainedIncompleteSets: 0,
    hasImportHistory: true,
    activeSelectionIncomplete: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
