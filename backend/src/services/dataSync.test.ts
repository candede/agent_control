import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { AppError } from "../errors.js";
import type { DataSyncRun, DataSyncSourceId, DataSyncSourceStatus } from "../types/dataSync.js";
import type { AuthenticatedUser } from "../types/session.js";
import type { CopilotUsageRefreshResult, CopilotUsageService } from "./copilotUsage.js";
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

  it.each(["initial", "incremental", "full"] as const)("starts only automatic sources by default in %s mode", async mode => {
    const harness = serviceHarness();
    const started = await harness.service.start(user, { mode });
    expect(started.sources.map(source => source.source)).toEqual(["users", "graph_packages", "power_platform"]);
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
      onDirectoryProgress: expect.any(Function),
    });
    await vi.waitFor(() => expect(harness.run.status).toBe("completed"));
    expect((await harness.service.state(user)).usageImportRequired).toBe(true);
  });

  it("passes the clean full opt-in through admission while retaining accepted official usage", async () => {
    const harness = serviceHarness();
    harness.officialUsage.getPublished.mockResolvedValue(acceptedUsage() as never);
    const started = await harness.service.start(user, { mode: "full", clearSavedData: true });
    expect(harness.repository.submit).toHaveBeenCalledWith({
      tenantId: user.tenantId, principalId: user.homeAccountId,
    }, { mode: "full", clearSavedData: true });
    expect(started.sources.map(source => source.source)).toEqual(["users", "graph_packages", "power_platform"]);
    expect((await harness.service.state(user)).sources.find(source => source.source === "usage_reports")).toMatchObject({
      status: "succeeded", count: 3, canRetry: false,
    });
    await vi.waitFor(() => expect(harness.copilotUsage.refreshUsers).toHaveBeenCalled());
  });

  it("waits for the new native inventory before resolving people, without delaying licensed collection", async () => {
    const harness = serviceHarness();
    const pending = deferred<ReturnType<typeof powerPlatformJob>>();
    harness.powerPlatform.start.mockReturnValueOnce(pending.promise);
    harness.copilotUsage.refreshUsers.mockImplementationOnce(async (_user, _signal, options) => {
      await options.onDirectoryProgress?.(7);
      return { status: "succeeded", count: 7, message: "Saved seven checked directory users." };
    });
    await harness.service.start(user, { mode: "full" });
    await vi.waitFor(() => expect(harness.copilotUsage.refreshUsers).toHaveBeenCalled());
    await vi.waitFor(() => expect(harness.run.sources.find(source => source.source === "users")).toMatchObject({
      status: "running", count: null, message: expect.stringContaining("Waiting for Power Platform"),
    }));
    expect(harness.agentPeople.refreshReferences).not.toHaveBeenCalled();
    pending.resolve(powerPlatformJob(randomUUID(), "succeeded", 2));
    await vi.waitFor(() => expect(harness.agentPeople.refreshReferences).toHaveBeenCalledWith(
      user, expect.any(AbortSignal), { runId: harness.run.id, jobId: expect.any(String) }, { incompleteOnly: false },
    ));
    await vi.waitFor(() => expect(harness.run.sources.find(value => value.source === "users")).toMatchObject({
      status: "succeeded", count: 7,
    }));
  });

  it("reports partial Users success when referenced identities fail and preserves licensed counts", async () => {
    const harness = serviceHarness();
    harness.agentPeople.refreshReferences.mockResolvedValueOnce({ changed: true, resolved: 3, notFound: 1, failed: 2 });
    await harness.service.start(user, { mode: "incremental", sources: ["users"] });
    await vi.waitFor(() => expect(harness.run.sources.find(value => value.source === "users")).toMatchObject({
      status: "partial", count: 0, canRetry: true, message: expect.stringContaining("2 lookup failures"),
    }));
  });

  it("does not silently declare success when the people provider fails", async () => {
    const harness = serviceHarness();
    harness.agentPeople.refreshReferences.mockRejectedValueOnce(new Error("network unavailable"));
    await harness.service.start(user, { mode: "incremental", sources: ["users"] });
    await vi.waitFor(() => expect(harness.run.sources.find(value => value.source === "users")).toMatchObject({
      status: "partial", count: 0, canRetry: true, message: expect.stringContaining("not fully refreshed"),
    }));
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

  it("keeps every saved source visible after a users-only completed run, without requiring manual reports for onboarding", async () => {
    const harness = serviceHarness();
    for (const [index, marker] of harness.markers.entries()) {
      if (marker.source !== "usage_reports") Object.assign(marker, {
        status: "succeeded", count: index * 10, lastSuccessAt: harness.run.startedAt,
      });
    }
    harness.run.sources = [{ ...harness.run.sources[0], status: "succeeded", count: 0 }];
    harness.run.status = "completed";
    const state = await harness.service.state(user);
    expect(state).toMatchObject({ onboardingRequired: false, usageImportRequired: true });
    expect(state.sources).toEqual([
      expect.objectContaining({ source: "users", status: "succeeded", count: 0 }),
      expect.objectContaining({ source: "graph_packages", status: "succeeded", count: 10 }),
      expect.objectContaining({ source: "power_platform", status: "succeeded", count: 20 }),
      expect.objectContaining({ source: "usage_reports", status: "not_started", count: null }),
    ]);
    expect(state.run?.sources).toHaveLength(1);
  });

  it.each(["partial", "failed", "cancelled"] as const)("retains saved counts while the newer Users attempt is %s", async status => {
    const harness = serviceHarness();
    Object.assign(harness.markers[0], { status: "succeeded", count: 40, lastSuccessAt: harness.run.startedAt });
    harness.run.sources = [{ ...harness.run.sources[0], status, count: 3, canRetry: true }];
    harness.run.status = status === "cancelled" ? "cancelled" : "partial";
    const state = await harness.service.state(user);
    expect(state.sources[0]).toMatchObject({ source: "users", status: "succeeded", count: 40 });
    expect(state.run?.sources[0]).toMatchObject({ source: "users", status, count: 3 });
  });

  it.each(["users-only", "succeeded", "cancelled", "no-run"] as const)(
    "reconciles the currently accepted usage selection independently of a %s latest run",
    async latest => {
      const harness = serviceHarness();
      const missing = await harness.officialUsage.getPublished();
      harness.run.sources = [harness.run.sources.find(source => source.source === (latest === "users-only" ? "users" : "usage_reports"))!];
      harness.run.sources[0].status = latest === "cancelled" ? "cancelled" : "succeeded";
      harness.run.sources[0].count = 99;
      harness.run.status = latest === "cancelled" ? "cancelled" : "completed";
      if (latest === "no-run") harness.repository.getLatestRun.mockResolvedValue(undefined);
      const historical = structuredClone(harness.run);
      harness.officialUsage.getPublished.mockResolvedValue(acceptedUsage() as never);
      expect((await harness.service.state(user)).sources[3]).toMatchObject({ status: "succeeded", count: 3 });

      const replacement = acceptedUsage();
      replacement.reports.users.rows.push({});
      replacement.activeSet.acceptedAt = "2026-09-16T10:00:00.000Z";
      harness.officialUsage.getPublished.mockResolvedValue(replacement as never);
      const current = await harness.service.state(user);
      expect(current.sources[3]).toMatchObject({
        source: "usage_reports", status: "succeeded", count: 4, lastSuccessAt: replacement.activeSet.acceptedAt,
      });
      expect(harness.repository.recordSuccessMarker).toHaveBeenLastCalledWith(
        { tenantId: user.tenantId, principalId: user.homeAccountId }, "usage_reports", 4, replacement.activeSet.acceptedAt,
      );

      harness.officialUsage.getPublished.mockResolvedValue(missing);
      const removed = await harness.service.state(user);
      expect(removed.usageImportRequired).toBe(true);
      expect(removed.sources[3]).toMatchObject({
        status: "not_started", count: null, lastSuccessAt: null, updatedAt: null,
      });
      expect(harness.run).toEqual(historical);
    },
  );

  it("preserves explicit manual report requests and waits for an administrator's upload", async () => {
    const harness = serviceHarness();
    expect((await harness.service.start(user, { mode: "initial", sources: ["usage_reports"] })).sources).toEqual([
      expect.objectContaining({ source: "usage_reports", status: "awaiting_upload", count: null, canRetry: false }),
    ]);
    expect(harness.packages.submit).not.toHaveBeenCalled();
    expect(harness.copilotUsage.refreshUsers).not.toHaveBeenCalled();
  });

  it("treats a complete accepted zero-row report bundle as saved usage rather than a required import", async () => {
    const harness = serviceHarness();
    const published = acceptedUsage();
    for (const report of Object.values(published.reports)) report.rows.length = 0;
    harness.officialUsage.getPublished.mockResolvedValue(published as never);
    const state = await harness.service.state(user);
    expect(state.usageImportRequired).toBe(false);
    expect(state.sources[3]).toMatchObject({ source: "usage_reports", status: "succeeded", count: 0 });
  });

  it.each(["graph_packages", "power_platform"] as const)("projects measured %s progress and preserves its phase message", async sourceId => {
    const harness = serviceHarness();
    const source = harness.run.sources.find(value => value.source === sourceId)!;
    source.status = "running";
    source.jobId = randomUUID();
    Object.assign(harness.markers.find(value => value.source === sourceId)!, { status: "succeeded", count: 50 });
    const job = {
      ...(sourceId === "graph_packages" ? packageJob(source.jobId, "running", 7) : powerPlatformJob(source.jobId, "running", 7)),
      totalRecords: 120,
      message: "Checking matching identities: 7 of 120 checked.",
    };
    const provider = sourceId === "graph_packages" ? harness.packages : harness.powerPlatform;
    provider.get.mockResolvedValueOnce(job as never);
    const state = await harness.service.state(user);
    expect(state.run?.sources.find(value => value.source === sourceId)).toMatchObject({
      status: "running", count: 7, message: job.message,
    });
    expect(state.sources.find(value => value.source === sourceId)).toMatchObject({ status: "succeeded", count: 50 });

    provider.get.mockResolvedValueOnce({ ...job, status: "succeeded", totalRecords: 12, observedCount: 10 } as never);
    const completed = await harness.service.state(user);
    expect(completed.run?.sources.find(value => value.source === sourceId)).toMatchObject({ status: "succeeded", count: 12 });
    expect(completed.sources.find(value => value.source === sourceId)).toMatchObject({ status: "succeeded", count: 12 });
  });

  it.each(["graph_packages", "power_platform"] as const)("does not label %s targets as observed records before or after a failed attempt", async sourceId => {
    const harness = serviceHarness();
    const job = sourceId === "graph_packages"
      ? packageJob(randomUUID(), "waiting_authorization", 0)
      : powerPlatformJob(randomUUID(), "waiting_authorization", 0);
    const provider = sourceId === "graph_packages" ? harness.packages : harness.powerPlatform;
    provider.submit.mockResolvedValueOnce({ ...job, totalRecords: 90 } as never);
    provider.start.mockResolvedValueOnce({ ...job, status: "failed", observedCount: 4, totalRecords: 90 } as never);
    await harness.service.start(user, { mode: "incremental", sources: [sourceId] });
    await vi.waitFor(() => expect(harness.run.sources[0]).toMatchObject({ status: "failed", count: 4 }));
    expect(harness.repository.updateSource).toHaveBeenCalledWith(
      expect.anything(), harness.run.id, sourceId, expect.objectContaining({ status: "waiting_authorization", count: 0 }),
    );
  });

  it("persists count-only Users page progress and exposes the agent-people phase before success", async () => {
    const harness = serviceHarness();
    Object.assign(harness.markers[0], { status: "succeeded", count: 40, lastSuccessAt: harness.run.startedAt });
    const reading = deferred<CopilotUsageRefreshResult>();
    const resolving = deferred<Awaited<ReturnType<typeof harness.agentPeople.refreshReferences>>>();
    harness.copilotUsage.refreshUsers.mockImplementationOnce(async (_user, _signal, options) => {
      await options.onDirectoryProgress?.(12);
      return reading.promise;
    });
    harness.agentPeople.refreshReferences.mockReturnValueOnce(resolving.promise);
    await harness.service.start(user, { mode: "incremental", sources: ["users"] });
    await vi.waitFor(() => expect(harness.run.sources[0]).toMatchObject({
      status: "running", count: 12, message: expect.stringContaining("Checked 12 directory users from Copilot-capable products and active report identities"),
    }));
    reading.resolve({ status: "succeeded", count: 12, message: "Saved directory/license and app-activity sources." });
    await vi.waitFor(() => expect(harness.agentPeople.refreshReferences).toHaveBeenCalled());
    expect(harness.run.sources[0]).toMatchObject({
      status: "running", count: null, message: expect.stringContaining("Resolving agent people"),
    });
    const state = await harness.service.state(user);
    expect(state.sources[0]).toMatchObject({ source: "users", status: "succeeded", count: 40 });
    expect(state.run?.sources[0]).toMatchObject({ source: "users", status: "running", count: null });
    resolving.resolve({ changed: true, resolved: 2, notFound: 1, failed: 0 });
    await vi.waitFor(() => expect(harness.run.sources[0]).toMatchObject({ status: "succeeded", count: 12 }));
  });

  it("does not present a retained directory total as newly observed when a people-only retry fails", async () => {
    const harness = serviceHarness();
    harness.copilotUsage.refreshUsers.mockResolvedValueOnce({
      status: "succeeded", count: 80, message: "All saved user sources already completed successfully.",
    });
    harness.agentPeople.refreshReferences.mockResolvedValueOnce({ changed: false, resolved: 0, notFound: 0, failed: 1 });
    await harness.service.start(user, { mode: "incremental", sources: ["users"] });
    await vi.waitFor(() => expect(harness.run.sources[0]).toMatchObject({ status: "partial", count: null }));
  });

  it("surfaces failed durable Users progress writes as a failed attempt", async () => {
    const harness = serviceHarness();
    const update = harness.repository.updateSource.getMockImplementation()!;
    harness.repository.updateSource.mockImplementation(async (...args) => {
      if (args[3].count === 5) throw new Error("Progress persistence unavailable.");
      return update(...args);
    });
    harness.copilotUsage.refreshUsers.mockImplementationOnce(async (_user, _signal, options) => {
      await options.onDirectoryProgress?.(5);
      throw new Error("Must not continue after failed progress persistence.");
    });
    await harness.service.start(user, { mode: "incremental", sources: ["users"] });
    await vi.waitFor(() => expect(harness.run.sources[0]).toMatchObject({ status: "failed", count: null, canRetry: true }));
    expect(harness.agentPeople.refreshReferences).not.toHaveBeenCalled();
  });

  it("rejects late Users page progress after cancellation without writing or resolving people", async () => {
    const harness = serviceHarness();
    const reading = deferred<CopilotUsageRefreshResult>();
    let onProgress: Parameters<CopilotUsageService["refreshUsers"]>[2]["onDirectoryProgress"];
    harness.copilotUsage.refreshUsers.mockImplementationOnce(async (_user, _signal, options) => {
      onProgress = options.onDirectoryProgress;
      await onProgress?.(2);
      return reading.promise;
    });
    await harness.service.start(user, { mode: "incremental", sources: ["users"] });
    await vi.waitFor(() => expect(harness.run.sources[0].count).toBe(2));
    const cancellation = harness.service.cancel(user, harness.run.id);
    await vi.waitFor(() => expect(harness.repository.cancel).toHaveBeenCalled());
    await expect(onProgress!(3)).rejects.toMatchObject({ code: "read_job_cancelled" });
    reading.resolve({ status: "succeeded", count: 3, message: "Finished after cancellation." });
    await cancellation;
    expect(harness.run.sources[0]).toMatchObject({ status: "cancelled", count: 2 });
    expect(harness.agentPeople.refreshReferences).not.toHaveBeenCalled();
    expect(harness.repository.updateSource.mock.calls.some(call => call[3].count === 3)).toBe(false);
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

  it.each(["graph_packages", "power_platform"] as const)(
    "waits for the prior %s child cancellation before admitting and launching a retry",
    async sourceId => {
      const harness = serviceHarness();
      const source = harness.run.sources.find(value => value.source === sourceId)!;
      const previousJobId = randomUUID();
      Object.assign(source, { status: "permission_required", canRetry: true, jobId: previousJobId });
      const cancelled = deferred<void>();
      const provider = sourceId === "graph_packages" ? harness.packages : harness.powerPlatform;
      if (sourceId === "graph_packages") {
        harness.packages.cancel.mockImplementationOnce(async (_user, id) => {
          await cancelled.promise;
          return packageJob(id, "cancelled", 0);
        });
      } else {
        harness.powerPlatform.cancel.mockImplementationOnce(async (_user, id) => {
          await cancelled.promise;
          return powerPlatformJob(id, "cancelled", 0);
        });
      }
      harness.repository.retry.mockImplementation(async () => {
        Object.assign(source, { status: "queued", canRetry: false, jobId: null });
        return [sourceId];
      });
      const retry = harness.service.retry(user, harness.run.id, [sourceId]);
      try {
        await vi.waitFor(() => expect(provider.cancel).toHaveBeenCalledWith(
          user, previousJobId, ...(sourceId === "graph_packages" ? ["delegated" as const] : []),
        ));
        expect(harness.repository.retry).not.toHaveBeenCalled();
        expect(harness.packages.submit).not.toHaveBeenCalled();
        expect(harness.powerPlatform.submit).not.toHaveBeenCalled();
      } finally {
        cancelled.resolve();
        await retry;
      }
      expect(harness.repository.retry).toHaveBeenCalledWith(
        { tenantId: user.tenantId, principalId: user.homeAccountId }, harness.run.id, [sourceId],
      );
      await vi.waitFor(() => expect(source.status).toBe("succeeded"));
      expect(provider.submit).toHaveBeenCalledTimes(1);
    },
  );

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

  it.each([
    ["start", "sign-out"], ["start", "shutdown"], ["retry", "sign-out"], ["retry", "shutdown"],
  ] as const)("joins a pending %s admission on %s", async (action, stopping) => {
    const harness = serviceHarness();
    const gate = deferred<void>();
    const source = harness.run.sources[0];
    harness.run.sources = [source];
    if (action === "start") {
      const submit = harness.repository.submit.getMockImplementation()!;
      harness.repository.submit.mockImplementation(async (...args) => {
        await gate.promise;
        return submit(...args);
      });
    } else {
      Object.assign(source, { status: "failed", canRetry: true });
      harness.run.status = "partial";
      harness.repository.retry.mockImplementation(async () => {
        await gate.promise;
        Object.assign(source, { status: "queued", canRetry: false });
        harness.run.status = "running";
        return ["users"];
      });
    }
    harness.repository.pausePrincipal.mockImplementation(async () => {
      if (["queued", "running"].includes(source.status)) {
        Object.assign(source, { status: "waiting_authorization", canRetry: true });
        harness.run.status = "waiting";
      }
      return 1;
    });
    const request = (action === "start"
      ? harness.service.start(user, { mode: "incremental", sources: ["users"] })
      : harness.service.retry(user, harness.run.id, ["users"])).then(
      value => ({ value, error: undefined }), error => ({ value: undefined, error }),
    );
    await vi.waitFor(() => expect(harness.repository[action === "start" ? "submit" : "retry"]).toHaveBeenCalled());
    let stopped = false;
    const stop = (stopping === "sign-out"
      ? harness.service.waitForPrincipalAuthorization({ tenantId: user.tenantId!, principalId: user.homeAccountId })
      : harness.service.drain()).then(() => { stopped = true; });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(stopped).toBe(false);
    } finally {
      gate.resolve();
      await request;
      await stop;
    }
    expect((await request).error).toMatchObject({ code: "interaction_required" });
    expect(source).toMatchObject({ status: "waiting_authorization", canRetry: true });
    expect(harness.copilotUsage.refreshUsers).not.toHaveBeenCalled();
    if (stopping === "shutdown") {
      await expect(harness.service.start(user, { mode: "initial" })).rejects.toMatchObject({ code: "data_sync_shutdown" });
      await expect(harness.service.retry(user, harness.run.id, ["users"])).rejects.toMatchObject({ code: "data_sync_shutdown" });
    } else {
      await harness.service.retry(user, harness.run.id, ["users"]);
      await vi.waitFor(() => expect(source.status).toBe("succeeded"));
    }
  });

  it("cancels a retry still waiting for durable admission before it can launch", async () => {
    const harness = serviceHarness();
    const source = harness.run.sources[0];
    harness.run.sources = [source];
    Object.assign(source, { status: "failed", canRetry: true });
    harness.run.status = "partial";
    const gate = deferred<void>();
    harness.repository.retry.mockImplementation(async () => {
      await gate.promise;
      Object.assign(source, { status: "queued", canRetry: false });
      harness.run.status = "running";
      return ["users"];
    });
    const retry = harness.service.retry(user, harness.run.id, ["users"]).catch(error => error);
    await vi.waitFor(() => expect(harness.repository.retry).toHaveBeenCalled());
    let cancelled = false;
    const cancellation = harness.service.cancel(user, harness.run.id).then(() => { cancelled = true; });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(cancelled).toBe(false);
    } finally {
      gate.resolve();
      await retry;
      await cancellation;
    }
    expect(await retry).toMatchObject({ code: "read_job_cancelled" });
    expect(harness.run.status).toBe("cancelled");
    expect(harness.copilotUsage.refreshUsers).not.toHaveBeenCalled();
  });

  it("reserves a retry before asynchronous reads so another source cannot be queued without a worker", async () => {
    const harness = serviceHarness();
    for (const source of harness.run.sources) Object.assign(source, { status: "failed", canRetry: true });
    harness.run.status = "partial";
    harness.repository.retry.mockImplementation(async (_scope, _id, sources: DataSyncSourceId[]) => {
      for (const source of harness.run.sources) {
        if (sources.includes(source.source)) Object.assign(source, { status: "queued", canRetry: false });
      }
      harness.run.status = "running";
      return sources;
    });
    const gate = deferred<DataSyncRun>();
    harness.repository.getRun.mockReturnValueOnce(gate.promise);
    const retry = harness.service.retry(user, harness.run.id, ["graph_packages"]);
    try {
      await expect(harness.service.retry(user, harness.run.id, ["power_platform"])).rejects.toMatchObject({
        code: "data_sync_active",
      });
      expect(harness.repository.retry).not.toHaveBeenCalled();
    } finally {
      gate.resolve(harness.run);
      await retry;
    }
    await vi.waitFor(() => expect(harness.run.sources.find(source => source.source === "graph_packages")?.status).toBe("succeeded"));
    expect(harness.powerPlatform.submit).not.toHaveBeenCalled();
  });

  it.each([
    ["graph_packages", "retry"], ["graph_packages", "cancel"], ["power_platform", "retry"], ["power_platform", "cancel"],
  ] as const)("allows a retained %s child to expire before %s", async (sourceId, action) => {
    const harness = serviceHarness();
    const source = harness.run.sources.find(value => value.source === sourceId)!;
    harness.run.sources = [source];
    Object.assign(source, { status: "waiting_authorization", jobId: randomUUID(), canRetry: true });
    harness.run.status = "waiting";
    const provider = sourceId === "graph_packages" ? harness.packages : harness.powerPlatform;
    provider.get.mockRejectedValue(new AppError(404, "not_found", "The retained child has expired."));
    provider.cancel.mockRejectedValue(new AppError(404, "not_found", "The retained child has expired."));
    harness.repository.retry.mockImplementation(async () => {
      Object.assign(source, { status: "queued", jobId: null, canRetry: false });
      harness.run.status = "running";
      return [sourceId];
    });
    await harness.service[action](user, harness.run.id);
    if (action === "retry") {
      await vi.waitFor(() => expect(source.status).toBe("succeeded"));
      expect(provider.submit).toHaveBeenCalledTimes(1);
    } else {
      expect(source.status).toBe("cancelled");
      expect(provider.submit).not.toHaveBeenCalled();
    }
  });

  it.each(["graph_packages", "power_platform"] as const)("does not retry when %s child cancellation fails for a reason other than absence", async sourceId => {
    const harness = serviceHarness();
    const source = harness.run.sources.find(value => value.source === sourceId)!;
    Object.assign(source, { status: "permission_required", jobId: randomUUID(), canRetry: true });
    const provider = sourceId === "graph_packages" ? harness.packages : harness.powerPlatform;
    const failure = new AppError(503, "provider_error", "Child cancellation is unavailable.");
    provider.cancel.mockRejectedValue(failure);
    await expect(harness.service.retry(user, harness.run.id, [sourceId])).rejects.toBe(failure);
    expect(harness.repository.retry).not.toHaveBeenCalled();
    expect(provider.submit).not.toHaveBeenCalled();
  });

  it("leaves another principal's pending admission unaffected by sign-out", async () => {
    const harness = serviceHarness();
    const gate = deferred<void>();
    const submit = harness.repository.submit.getMockImplementation()!;
    harness.repository.submit.mockImplementationOnce(async (...args) => {
      await gate.promise;
      return submit(...args);
    });
    const request = harness.service.start(user, { mode: "initial", sources: ["users"] });
    await vi.waitFor(() => expect(harness.repository.submit).toHaveBeenCalled());
    await harness.service.waitForPrincipalAuthorization({ tenantId: user.tenantId!, principalId: "another-viewer" });
    gate.resolve();
    await request;
    await vi.waitFor(() => expect(harness.run.sources[0].status).toBe("succeeded"));
  });

  it("surfaces interrupted-admission persistence failures during shutdown", async () => {
    const harness = serviceHarness();
    const gate = deferred<void>();
    const submit = harness.repository.submit.getMockImplementation()!;
    harness.repository.submit.mockImplementationOnce(async (...args) => {
      await gate.promise;
      return submit(...args);
    });
    const failure = new Error("Cannot persist waiting authorization.");
    harness.repository.pausePrincipal.mockRejectedValue(failure);
    const request = harness.service.start(user, { mode: "initial", sources: ["users"] }).catch(error => error);
    await vi.waitFor(() => expect(harness.repository.submit).toHaveBeenCalled());
    const drain = harness.service.drain();
    const assertion = expect(drain).rejects.toBe(failure);
    gate.resolve();
    await assertion;
    expect(await request).toBe(failure);
    expect(harness.copilotUsage.refreshUsers).not.toHaveBeenCalled();
  });

  it("bounds pending admissions and releases their capacity after failure", async () => {
    const harness = serviceHarness();
    const gate = deferred<void>();
    const submit = harness.repository.submit.getMockImplementation()!;
    harness.repository.submit.mockImplementation(async (...args) => {
      await gate.promise;
      return submit(...args);
    });
    const requests = Promise.allSettled(Array.from({ length: 4 }, () =>
      harness.service.start(user, { mode: "initial", sources: ["users"] })));
    await vi.waitFor(() => expect(harness.repository.submit).toHaveBeenCalledTimes(4));
    await expect(harness.service.start(user, { mode: "initial" })).rejects.toMatchObject({ code: "data_sync_capacity" });
    const failure = new Error("Admission unavailable.");
    gate.reject(failure);
    expect(await requests).toEqual(Array.from({ length: 4 }, () => ({ status: "rejected", reason: failure })));
    harness.repository.submit.mockImplementation(submit);
    await harness.service.start(user, { mode: "initial", sources: ["users"] });
    await vi.waitFor(() => expect(harness.run.sources[0].status).toBe("succeeded"));
  });

  it("cleans sibling jobs and surfaces failure when both source and worker status persistence fail", async () => {
    const harness = serviceHarness();
    const submitted = deferred<ReturnType<typeof powerPlatformJob>>();
    harness.powerPlatform.submit.mockReturnValueOnce(submitted.promise);
    const failure = new Error("Status persistence unavailable.");
    harness.repository.attachJob.mockRejectedValueOnce(failure);
    harness.repository.updateSource.mockRejectedValue(failure);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await harness.service.start(user, { mode: "initial", sources: ["users", "power_platform"] });
      await vi.waitFor(() => expect(harness.repository.updateSource).toHaveBeenCalled());
      const drain = harness.service.drain();
      const assertion = expect(drain).rejects.toBe(failure);
      submitted.resolve(powerPlatformJob(randomUUID(), "waiting_authorization", 0));
      await assertion;
      expect(harness.powerPlatform.start).not.toHaveBeenCalled();
      expect(harness.powerPlatform.cancel).toHaveBeenCalled();
      expect(log.mock.calls.map(([entry]) => JSON.parse(entry))).toEqual([
        {
          timestamp: expect.any(String), level: "error", event: "data_sync_worker_failed",
          runId: harness.run.id, errorCode: "internal_error", errorKind: "unexpected",
        },
        {
          timestamp: expect.any(String), level: "error", event: "data_sync_worker_status_failed",
          runId: harness.run.id, errorCode: "internal_error", errorKind: "unexpected",
        },
      ]);
    } finally {
      log.mockRestore();
    }
  });

  it("retains sibling work after a source status-write failure so cancellation still joins and cleans it", async () => {
    const harness = serviceHarness();
    const submitted = deferred<ReturnType<typeof powerPlatformJob>>();
    harness.powerPlatform.submit.mockReturnValueOnce(submitted.promise);
    harness.repository.attachJob.mockRejectedValueOnce(new Error("Users job write unavailable."));
    const update = harness.repository.updateSource.getMockImplementation()!;
    let failedWrite = false;
    harness.repository.updateSource.mockImplementation(async (...args) => {
      if (args[2] === "users" && args[3].status === "failed" && !failedWrite) {
        failedWrite = true;
        throw new Error("Users failure write unavailable.");
      }
      return update(...args);
    });
    await harness.service.start(user, { mode: "incremental", sources: ["users", "power_platform"] });
    await vi.waitFor(() => expect(failedWrite).toBe(true));
    await new Promise<void>(resolve => setImmediate(resolve));
    let cancelled = false;
    const cancellation = harness.service.cancel(user, harness.run.id).then(() => { cancelled = true; });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(cancelled).toBe(false);
    } finally {
      submitted.resolve(powerPlatformJob(randomUUID(), "waiting_authorization", 0));
      await cancellation;
    }
    expect(harness.powerPlatform.start).not.toHaveBeenCalled();
    expect(harness.powerPlatform.cancel).toHaveBeenCalled();
  });
});

function serviceHarness() {
  const run = dataSyncRun();
  const markers: DataSyncSourceStatus[] = run.sources.map(source => ({ ...source, status: "not_started", updatedAt: null }));
  const saveMarker = (source: DataSyncSourceId, count: number | null, lastSuccessAt: string) => {
    Object.assign(markers.find(value => value.source === source)!, {
      status: "succeeded", count, lastSuccessAt, updatedAt: lastSuccessAt,
    });
  };
  const repository = {
    submit: vi.fn(async (_scope, input) => {
      const requested = new Set<DataSyncSourceId>(input.sources ?? ["users", "graph_packages", "power_platform"]);
      run.mode = input.mode;
      run.sources = run.sources.filter(source => requested.has(source.source));
      return { run, created: true };
    }),
    getRun: vi.fn(async () => run),
    getLatestRun: vi.fn(async (): Promise<DataSyncRun | undefined> => run),
    listRuns: vi.fn(async () => [run]),
    getSourceAttempt: vi.fn(async () => 1),
    listMarkers: vi.fn(async () => markers),
    attachJob: vi.fn(async (_scope, _runId, source: DataSyncSourceId, jobId: string) => {
      run.sources.find(value => value.source === source)!.jobId = jobId;
    }),
    updateSource: vi.fn(async (_scope, _runId, source: DataSyncSourceId, update: Partial<DataSyncSourceStatus>) => {
      const current = run.sources.find(value => value.source === source)!;
      if (!["running", "waiting"].includes(run.status) || current.status === "succeeded"
        || (update.jobId && current.jobId && update.jobId !== current.jobId)) return run;
      Object.assign(current, update, { updatedAt: new Date().toISOString() });
      if (update.status === "succeeded") saveMarker(source, current.count, current.lastSuccessAt ?? current.updatedAt!);
      const statuses = run.sources.map(value => value.status);
      run.status = statuses.some(status => ["queued", "running"].includes(status)) ? "running"
        : statuses.some(status => ["waiting_authorization", "permission_required", "awaiting_upload"].includes(status)) ? "waiting"
          : statuses.every(status => status === "succeeded") ? "completed" : "partial";
      return run;
    }),
    recordSuccessMarker: vi.fn(async (_scope, source: DataSyncSourceId, count: number | null, lastSuccessAt: string) => saveMarker(source, count, lastSuccessAt)),
    retry: vi.fn(async (_scope, _id, sources) => sources ?? []),
    cancel: vi.fn(async () => {
      run.status = "cancelled";
      for (const source of run.sources) if (source.status !== "succeeded") source.status = "cancelled";
      return run;
    }),
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
    refreshUsers: vi.fn(async (
      _user: AuthenticatedUser, _signal: AbortSignal | undefined, options: Parameters<CopilotUsageService["refreshUsers"]>[2],
    ): Promise<CopilotUsageRefreshResult> => {
      await options.onDirectoryProgress?.(0);
      return { status: "succeeded", count: 0, message: "Saved normalized zero-row user sources." };
    }),
  };
  const agentPeople = {
    refreshReferences: vi.fn(async () => ({ changed: false, resolved: 0, notFound: 0, failed: 0 })),
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
    agentPeople,
    officialUsage,
    wait: vi.fn(async () => undefined),
  });
  return { service, run, markers, repository, packages, powerPlatform, copilotUsage, agentPeople, officialUsage };
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
