import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  close: vi.fn<(callback?: (error?: Error) => void) => void>(),
  listen: vi.fn(),
  storeClose: vi.fn(),
  poolEnd: vi.fn<() => Promise<void>>(),
  enterMaintenance: vi.fn(),
  maintenanceActive: vi.fn(),
  loadOperationalState: vi.fn(),
  readOperationalState: vi.fn(),
  query: vi.fn(),
  verifySchema: vi.fn(),
  log: vi.fn(),
  resources: vi.fn(),
  recover: vi.fn(),
  dataSyncDrain: vi.fn<() => Promise<void>>(),
  bulkDrain: vi.fn<() => Promise<void>>(),
  quarantineDrain: vi.fn<() => Promise<void>>(),
  packageDrain: vi.fn<() => Promise<void>>(),
  powerPlatformDrain: vi.fn<() => Promise<void>>(),
  purviewDrain: vi.fn<() => Promise<void>>(),
  defenderDrain: vi.fn<() => Promise<void>>(),
  reportStart: vi.fn(),
  reportDrain: vi.fn<() => Promise<void>>(),
  inventoryStart: vi.fn(),
  inventoryDrain: vi.fn<() => Promise<void>>(),
}));
vi.mock("./config.js", () => ({ config: { port: 3001, tenants: [{ tenantId: "tenant-a" }, { tenantId: "tenant-b" }], nodeEnv: "test" }, validateRuntimeConfig: vi.fn() }));
vi.mock("./app.js", () => ({ createApp: () => ({ app: { listen: mocks.listen }, store: { close: mocks.storeClose } }) }));
vi.mock("./db/pool.js", () => ({ pool: { query: mocks.query, end: mocks.poolEnd, waitingCount: 0, totalCount: 2, idleCount: 2,
  admissionState: { foreground: 0, queue: 0 } } }));
vi.mock("./db/schema.js", () => ({ verifySchema: mocks.verifySchema }));
vi.mock("./db/packageMutationQualifications.js", () => ({ PackageMutationQualificationRepository: class { recoverInterrupted = mocks.recover; } }));
vi.mock("./db/copilotStudioQuarantineCanaries.js", () => ({ CopilotStudioQuarantineCanaryRepository: class { recoverInterrupted = mocks.recover; } }));
vi.mock("./services/bulkJobs.js", () => ({ bulkJobs: { recover: mocks.recover }, drainBulkJobs: mocks.bulkDrain }));
vi.mock("./services/copilotStudioQuarantineJobs.js", () => ({
  copilotStudioQuarantineJobs: { recoverInterrupted: mocks.recover }, drainCopilotStudioQuarantineJobs: mocks.quarantineDrain,
}));
vi.mock("./services/maintenance.js", () => ({ enterMaintenance: mocks.enterMaintenance, maintenanceActive: mocks.maintenanceActive }));
vi.mock("./services/defenderHunting.js", () => ({ defenderHunting: { recover: mocks.recover, drain: mocks.defenderDrain } }));
vi.mock("./services/dataSync.js", () => ({ dataSync: { recover: mocks.recover, drain: mocks.dataSyncDrain } }));
vi.mock("./services/packageInventory.js", () => ({ packageInventory: { recover: mocks.recover, drain: mocks.packageDrain } }));
vi.mock("./services/powerPlatformInventory.js", () => ({ powerPlatformInventory: { recover: mocks.recover, drain: mocks.powerPlatformDrain } }));
vi.mock("./services/purviewAudit.js", () => ({ purviewAudit: { recover: mocks.recover, drain: mocks.purviewDrain } }));
vi.mock("./services/reportExportDispatcher.js", () => ({
  reportRuntime: () => ({ start: mocks.reportStart, drain: mocks.reportDrain }),
}));
vi.mock("./services/inventoryRuntime.js", () => ({
  inventoryRuntime: () => ({ start: mocks.inventoryStart, drain: mocks.inventoryDrain }),
}));
vi.mock("./services/operationalState.js", () => ({
  loadOperationalState: mocks.loadOperationalState, readOperationalState: mocks.readOperationalState,
}));
vi.mock("./services/telemetry.js", () => ({
  operationalLog: mocks.log, observeDatabasePool: vi.fn(), observeRuntimeResources: mocks.resources,
  withTelemetryContext: (_fields: unknown, operation: () => unknown) => operation(),
}));

const childDrains = [mocks.bulkDrain, mocks.quarantineDrain, mocks.packageDrain, mocks.powerPlatformDrain,
  mocks.purviewDrain, mocks.defenderDrain, mocks.reportDrain, mocks.inventoryDrain];
let signals: Map<string, () => void>;
let completeHttp: ((error?: Error) => void) | undefined;

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  signals = new Map();
  completeHttp = undefined;
  const once = process.once.bind(process);
  vi.spyOn(process, "once").mockImplementation((event, listener) => {
    if (event === "SIGTERM" || event === "SIGINT") {
      signals.set(event, listener);
      return process;
    }
    return once(event, listener);
  });
  vi.spyOn(process, "exit").mockImplementation(vi.fn<typeof process.exit>());
  mocks.close.mockImplementation(callback => { completeHttp = callback; });
  mocks.listen.mockReturnValue({ close: mocks.close });
  mocks.loadOperationalState.mockResolvedValue({ mode: "normal" });
  mocks.verifySchema.mockResolvedValue(undefined);
  mocks.readOperationalState.mockResolvedValue({ mode: "normal" });
  mocks.maintenanceActive.mockReturnValue(false);
  mocks.poolEnd.mockResolvedValue();
  for (const drain of [mocks.dataSyncDrain, ...childDrains]) drain.mockResolvedValue();
  await import("./server.js");
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

describe("maintenance shutdown lifecycle", () => {
  it("passes a live operational admission fence to Power Platform startup recovery", async () => {
    const [admissionsOpen] = mocks.recover.mock.calls[0];
    expect(admissionsOpen).toEqual(expect.any(Function));
    await expect(admissionsOpen()).resolves.toBe(true);
    mocks.loadOperationalState.mockResolvedValue({ mode: "maintenance" });
    await expect(admissionsOpen()).resolves.toBe(false);
    mocks.loadOperationalState.mockResolvedValue({ mode: "normal" });
    mocks.maintenanceActive.mockReturnValue(true);
    await expect(admissionsOpen()).resolves.toBe(false);
  });

  it("rejects an incompatible schema before loading state, recovering work, or admitting HTTP", async () => {
    vi.clearAllTimers();
    vi.resetModules();
    for (const operation of [mocks.loadOperationalState, mocks.recover, mocks.listen, mocks.reportStart, mocks.inventoryStart]) operation.mockClear();
    mocks.verifySchema.mockRejectedValueOnce(new Error("Schema fingerprint mismatch."));
    await expect(import("./server.js")).rejects.toThrow("Schema fingerprint mismatch.");
    for (const operation of [mocks.loadOperationalState, mocks.recover, mocks.listen, mocks.reportStart, mocks.inventoryStart]) {
      expect(operation).not.toHaveBeenCalled();
    }
  });

  it("waits for schema verification before operational-state loading and any recovery", async () => {
    vi.clearAllTimers();
    vi.resetModules();
    for (const operation of [mocks.verifySchema, mocks.loadOperationalState, mocks.recover, mocks.listen]) operation.mockClear();
    const verified = Promise.withResolvers<void>();
    mocks.verifySchema.mockReturnValueOnce(verified.promise);
    const starting = import("./server.js");
    await vi.waitFor(() => expect(mocks.verifySchema).toHaveBeenCalledOnce());
    expect(mocks.loadOperationalState).not.toHaveBeenCalled();
    expect(mocks.recover).not.toHaveBeenCalled();
    expect(mocks.listen).not.toHaveBeenCalled();
    verified.resolve();
    await starting;
    expect(mocks.verifySchema.mock.invocationCallOrder[0]).toBeLessThan(mocks.loadOperationalState.mock.invocationCallOrder[0]);
    expect(mocks.loadOperationalState.mock.invocationCallOrder[0]).toBeLessThan(mocks.recover.mock.invocationCallOrder[0]);
    expect(mocks.recover.mock.invocationCallOrder.at(-1)!).toBeLessThan(mocks.listen.mock.invocationCallOrder[0]);
  });

  it.each(["process", "persisted"] as const)("does not run startup recovery during %s maintenance", async closure => {
    vi.clearAllTimers();
    vi.resetModules();
    mocks.recover.mockClear(); mocks.listen.mockClear();
    if (closure === "process") mocks.maintenanceActive.mockReturnValue(true);
    else mocks.loadOperationalState.mockResolvedValue({ mode: "maintenance" });
    await import("./server.js");
    expect(mocks.recover).not.toHaveBeenCalled();
    expect(mocks.listen).toHaveBeenCalledOnce();
  });

  it.each((["process", "persisted"] as const).flatMap(closure =>
    [1, 5, 6, 7, 8, 9, 10, 13].map(slice => ({ closure, slice })),
  ))("stops startup recovery after slice $slice closes $closure maintenance", async ({ closure, slice }) => {
    vi.clearAllTimers();
    vi.resetModules();
    mocks.recover.mockClear(); mocks.listen.mockClear();
    let calls = 0;
    mocks.recover.mockImplementation(async () => {
      if (++calls === slice) {
        if (closure === "process") mocks.maintenanceActive.mockReturnValue(true);
        else mocks.loadOperationalState.mockResolvedValue({ mode: "maintenance" });
      }
      return 0;
    });
    await import("./server.js");
    expect(mocks.recover).toHaveBeenCalledTimes(slice);
    expect(mocks.listen).toHaveBeenCalledOnce();
  });

  it.each(["bulk", "quarantine"] as const)("does not enter a second startup %s batch after maintenance closes", async stage => {
    vi.clearAllTimers();
    vi.resetModules();
    mocks.recover.mockClear(); mocks.listen.mockClear();
    let calls = 0;
    const slice = stage === "bulk" ? 6 : 7;
    mocks.recover.mockImplementation(async () => {
      if (++calls === slice) {
        mocks.loadOperationalState.mockResolvedValue({ mode: "maintenance" });
        return 1000;
      }
      return 0;
    });
    const startup = import("./server.js");
    await vi.waitFor(() => expect(mocks.listen).toHaveBeenCalledOnce());
    await startup;
    expect(mocks.recover).toHaveBeenCalledTimes(slice);
  });

  it("does not admit HTTP or more recovery after a failed startup state refresh", async () => {
    vi.clearAllTimers();
    vi.resetModules();
    mocks.recover.mockClear(); mocks.listen.mockClear();
    mocks.recover.mockImplementationOnce(async () => {
      mocks.loadOperationalState.mockRejectedValueOnce(new Error("State unavailable"));
      return 0;
    });
    await expect(import("./server.js")).rejects.toThrow("State unavailable");
    expect(mocks.recover).toHaveBeenCalledOnce();
    expect(mocks.listen).not.toHaveBeenCalled();
  });

  it("recovers saved interrupted work at startup without provider requalification", async () => {
    vi.clearAllTimers();
    vi.resetModules();
    mocks.recover.mockClear();
    mocks.loadOperationalState.mockResolvedValue({ mode: "normal", providerWorkEnabled: false });
    mocks.recover.mockResolvedValue(0);
    await import("./server.js");
    expect(mocks.recover).toHaveBeenCalledTimes(13);
  });

  it("keeps persisted startup maintenance reflected in the real provider-admission gate", async () => {
    vi.clearAllTimers();
    vi.resetModules();
    mocks.recover.mockClear();
    const state = { mode: "normal", provider_work_enabled: true, restored_from_at: null,
      deletion_reviewed_at: null, access_reviewed_at: null };
    mocks.query.mockImplementation(async () => ({ rowCount: 1, rows: [{ ...state }] }));
    const operationalState = await vi.importActual<typeof import("./services/operationalState.js")>("./services/operationalState.js");
    mocks.loadOperationalState.mockImplementation(operationalState.loadOperationalState);
    mocks.readOperationalState.mockImplementation(operationalState.readOperationalState);
    let calls = 0;
    mocks.recover.mockImplementation(async () => {
      if (++calls === 13) state.mode = "maintenance";
      return 0;
    });
    await import("./server.js");
    expect(operationalState.providerWorkEnabled()).toBe(false);
    expect(() => operationalState.requireProviderAdmissions()).toThrow(expect.objectContaining({ code: "maintenance" }));
  });

  it("does not expose HTTP or provider work while the real initial operational-state load is pending", async () => {
    vi.clearAllTimers();
    vi.resetModules();
    mocks.listen.mockClear(); mocks.recover.mockClear();
    const row = { mode: "normal", provider_work_enabled: true, restored_from_at: null,
      deletion_reviewed_at: null, access_reviewed_at: null };
    const initial = Promise.withResolvers<{ rowCount: number; rows: typeof row[] }>();
    mocks.query.mockReturnValueOnce(initial.promise).mockResolvedValue({ rowCount: 1, rows: [{ ...row }] });
    const operationalState = await vi.importActual<typeof import("./services/operationalState.js")>("./services/operationalState.js");
    mocks.loadOperationalState.mockImplementation(operationalState.loadOperationalState);
    const starting = import("./server.js");
    await vi.waitFor(() => expect(mocks.query).toHaveBeenCalledOnce());
    expect(mocks.listen).not.toHaveBeenCalled();
    expect(mocks.recover).not.toHaveBeenCalled();
    expect(operationalState.providerWorkEnabled()).toBe(false);
    expect(() => operationalState.requireProviderAdmissions()).toThrow(expect.objectContaining({ code: "maintenance" }));
    initial.resolve({ rowCount: 1, rows: [{ ...row }] });
    await starting;
    expect(mocks.listen).toHaveBeenCalledOnce();
    expect(operationalState.providerWorkEnabled()).toBe(true);
  });

  it.each(["read failure", "invalid provider flag", "incomplete review", "duplicate singleton"])(
    "closes the real provider-admission gate on periodic %s until a later recovery pass", async outcome => {
    vi.clearAllTimers();
    vi.resetModules();
    mocks.query.mockResolvedValue({ rowCount: 1, rows: [{
      mode: "normal", provider_work_enabled: true, restored_from_at: null, deletion_reviewed_at: null, access_reviewed_at: null,
    }] });
    const operationalState = await vi.importActual<typeof import("./services/operationalState.js")>("./services/operationalState.js");
    mocks.loadOperationalState.mockImplementation(operationalState.loadOperationalState);
    mocks.readOperationalState.mockImplementation(operationalState.readOperationalState);
    mocks.recover.mockResolvedValue(0);
    await import("./server.js");
    expect(operationalState.providerWorkEnabled()).toBe(true);
    if (outcome === "read failure") mocks.query.mockRejectedValueOnce(new Error("Private operational-state database detail."));
    else {
      const row = { mode: "normal", provider_work_enabled: outcome === "invalid provider flag" ? "false" : true,
        restored_from_at: outcome === "incomplete review" ? new Date() : null, deletion_reviewed_at: null, access_reviewed_at: null };
      mocks.query.mockResolvedValueOnce({ rowCount: outcome === "duplicate singleton" ? 2 : 1,
        rows: outcome === "duplicate singleton" ? [row, row] : [row] });
    }
    mocks.recover.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.recover).not.toHaveBeenCalled();
    expect(operationalState.providerWorkEnabled()).toBe(false);
    expect(() => operationalState.requireProviderAdmissions()).toThrow(expect.objectContaining({ status: 503, code: "maintenance" }));
    expect(JSON.stringify(mocks.log.mock.calls)).not.toContain("Private operational-state database detail.");
    await operationalState.readOperationalState();
    expect(operationalState.providerWorkEnabled()).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.recover).toHaveBeenCalledTimes(4);
    expect(operationalState.providerWorkEnabled()).toBe(true);
  });

  it("acceptance: startup drains full quarantine batches before admitting new HTTP jobs", async () => {
    vi.clearAllTimers();
    vi.resetModules();
    mocks.recover.mockClear(); mocks.listen.mockClear();
    let calls = 0;
    const nextBatch = Promise.withResolvers<number>();
    mocks.recover.mockImplementation(async () => {
      calls++;
      if (calls === 7) return 1000;
      if (calls === 8) return nextBatch.promise;
      return 0;
    });
    const startup = import("./server.js");
    await vi.waitFor(() => expect(mocks.recover).toHaveBeenCalledTimes(8));
    expect(mocks.recover.mock.calls.slice(6, 8)).toEqual([["tenant-a", true], ["tenant-a", true]]);
    expect(mocks.listen).not.toHaveBeenCalled();
    nextBatch.resolve(1);
    await vi.waitFor(() => expect(mocks.listen).toHaveBeenCalledOnce());
    await startup;
    expect(mocks.listen).toHaveBeenCalledOnce();
  });
  it("recovers expired bulk leases off HTTP reads without overlapping poll passes", async () => {
    mocks.recover.mockClear();
    let finish!: () => void;
    mocks.recover.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.resources).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      totalCount: 2, idleCount: 2, waitingCount: 0, admissionState: { foreground: 0, queue: 0 },
    }));
    expect(mocks.recover).toHaveBeenCalledExactlyOnceWith("tenant-a");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.recover).toHaveBeenCalledTimes(1);
    finish();
    await settle();
    expect(mocks.recover).toHaveBeenLastCalledWith("tenant-b");
    expect(mocks.recover).toHaveBeenCalledTimes(4);
    expect(mocks.recover.mock.calls).toEqual([["tenant-a"], ["tenant-a"], ["tenant-b"], ["tenant-b"]]);
  });
  it("does not admit periodic bulk recovery during database maintenance", async () => {
    mocks.recover.mockClear();
    mocks.loadOperationalState.mockResolvedValue({ mode: "maintenance" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.recover).not.toHaveBeenCalled();
  });
  it.each(["bulk", "quarantine"] as const)("stops the recovery pass when persisted maintenance closes during %s recovery", async stage => {
    mocks.recover.mockClear();
    let calls = 0;
    mocks.recover.mockImplementation(async () => {
      if (++calls === (stage === "bulk" ? 1 : 2)) mocks.loadOperationalState.mockResolvedValue({ mode: "maintenance" });
      return 0;
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.recover.mock.calls).toEqual(stage === "bulk" ? [["tenant-a"]] : [["tenant-a"], ["tenant-a"]]);
    mocks.loadOperationalState.mockResolvedValue({ mode: "normal" });
    mocks.recover.mockResolvedValue(0).mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.recover.mock.calls).toEqual([["tenant-a"], ["tenant-a"], ["tenant-b"], ["tenant-b"]]);
  });
  it.each(["marker", "shutdown"] as const)("does not recover when %s overtakes a persisted admission read", async closure => {
    mocks.recover.mockClear();
    const state = Promise.withResolvers<{ mode: string }>();
    mocks.loadOperationalState.mockReturnValueOnce(state.promise);
    await vi.advanceTimersByTimeAsync(30_000);
    if (closure === "marker") mocks.maintenanceActive.mockReturnValue(true);
    else { signals.get("SIGTERM")!(); completeHttp!(); }
    state.resolve({ mode: "normal" });
    await settle();
    expect(mocks.recover).not.toHaveBeenCalled();
    if (closure === "shutdown") expect(mocks.poolEnd).toHaveBeenCalledOnce();
  });
  it("stops recovery on a failed inter-slice state read, sanitizes the failure and retries a later pass", async () => {
    mocks.recover.mockClear();
    const failure = new Error("Private operational-state database detail.");
    mocks.recover.mockImplementationOnce(async () => {
      mocks.loadOperationalState.mockRejectedValueOnce(failure);
      return 0;
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.recover.mock.calls).toEqual([["tenant-a"]]);
    expect(mocks.log).toHaveBeenCalledWith("error", "job_recovery_failed", {
      errorCode: "job_recovery_failed", errorKind: "unexpected",
    });
    expect(JSON.stringify(mocks.log.mock.calls)).not.toContain(failure.message);
    mocks.recover.mockResolvedValue(0).mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.recover.mock.calls).toEqual([["tenant-a"], ["tenant-a"], ["tenant-b"], ["tenant-b"]]);
  });
  it("acceptance: shutdown drains the existing in-flight quarantine recovery pass before closing its pool", async () => {
    mocks.recover.mockClear();
    const recovery = Promise.withResolvers<void>();
    mocks.recover.mockResolvedValueOnce(undefined).mockReturnValueOnce(recovery.promise);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.recover.mock.calls).toEqual([["tenant-a"], ["tenant-a"]]);
    signals.get("SIGTERM")!();
    completeHttp!();
    await settle();
    expect(mocks.poolEnd).not.toHaveBeenCalled();
    recovery.resolve();
    await settle();
    expect(mocks.recover).toHaveBeenCalledTimes(2);
    expect(mocks.poolEnd).toHaveBeenCalledOnce();
  });
  it("recovers interrupted work for every configured tenant", () => {
    for (const tenantId of ["tenant-a", "tenant-b"]) {
      expect(mocks.recover).toHaveBeenCalledWith(tenantId, true);
      expect(mocks.recover.mock.calls.filter(([tenant]) => tenant === tenantId)).toHaveLength(4);
    }
  });

  it("starts the durable export dispatcher after recovery and before HTTP admission", () => {
    expect(mocks.reportStart).toHaveBeenCalledOnce();
    expect(mocks.recover.mock.invocationCallOrder.at(-1)!).toBeLessThan(mocks.reportStart.mock.invocationCallOrder[0]);
    expect(mocks.reportStart.mock.invocationCallOrder[0]).toBeLessThan(mocks.listen.mock.invocationCallOrder[0]);
    expect(mocks.inventoryStart).toHaveBeenCalledOnce();
    expect(mocks.recover.mock.invocationCallOrder.at(-1)!).toBeLessThan(mocks.inventoryStart.mock.invocationCallOrder[0]);
    expect(mocks.inventoryStart.mock.invocationCallOrder[0]).toBeLessThan(mocks.listen.mock.invocationCallOrder[0]);
  });

  it("keeps database and session persistence open until admitted HTTP requests have finished", async () => {
    signals.get("SIGTERM")!();
    await settle();
    expect(mocks.enterMaintenance).toHaveBeenCalledOnce();
    for (const drain of [mocks.dataSyncDrain, ...childDrains]) expect(drain).toHaveBeenCalledOnce();
    expect(mocks.storeClose).not.toHaveBeenCalled();
    expect(mocks.poolEnd).not.toHaveBeenCalled();
    expect(completeHttp).toBeTypeOf("function");
    completeHttp!();
    await settle();
    expect(mocks.storeClose).toHaveBeenCalledOnce();
    expect(mocks.poolEnd).toHaveBeenCalledOnce();
    expect(process.exit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("flushes the final metrics window after HTTP and workers drain (worker failure=%s)", async failed => {
    const { observeDataWork, flushDataWorkMetrics } = await import("./services/dataMetrics.js");
    const worker = Promise.withResolvers<void>();
    mocks.inventoryDrain.mockReturnValue(worker.promise);
    observeDataWork("export", { bytes: 10 });
    signals.get("SIGTERM")!();
    await settle();
    observeDataWork("export", { bytes: 20 });
    expect(mocks.log.mock.calls.some(([, event]) => event === "data_lifecycle_metrics")).toBe(false);
    if (failed) worker.reject(new Error("Synthetic worker drain failure."));
    else worker.resolve();
    await settle();
    expect(mocks.log.mock.calls.some(([, event]) => event === "data_lifecycle_metrics")).toBe(false);
    completeHttp!();
    await settle();
    expect(mocks.log).toHaveBeenCalledWith("info", "data_lifecycle_metrics", { stage: "export", count: 2, bytes: 20 });
    expect(flushDataWorkMetrics()).toEqual([]);
  });

  it("handles SIGTERM and SIGINT as one shutdown and drains the coordinator before its children", async () => {
    const sync = Promise.withResolvers<void>();
    mocks.dataSyncDrain.mockReturnValue(sync.promise);
    signals.get("SIGTERM")!();
    signals.get("SIGINT")!();
    expect(mocks.enterMaintenance).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.dataSyncDrain).toHaveBeenCalledOnce();
    for (const drain of childDrains) expect(drain).not.toHaveBeenCalled();
    completeHttp!();
    sync.resolve();
    await settle();
    for (const drain of childDrains) expect(drain).toHaveBeenCalledOnce();
    expect(mocks.poolEnd).toHaveBeenCalledOnce();
  });

  it("keeps the shutdown deadline active until database closure finishes", async () => {
    const end = Promise.withResolvers<void>();
    mocks.poolEnd.mockReturnValue(end.promise);
    const timeout = vi.spyOn(globalThis, "setTimeout");
    signals.get("SIGTERM")!();
    expect(timeout.mock.results[0].value.hasRef()).toBe(true);
    completeHttp!();
    await settle();
    expect(mocks.poolEnd).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    end.resolve();
    await settle();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["coordinator", "worker", "report-export", "http", "store", "pool"])("reports %s failures without leaking the error or abandoning other worker drains", async stage => {
    const failure = new Error("Private driver detail must not be logged");
    if (stage === "coordinator") mocks.dataSyncDrain.mockRejectedValue(failure);
    if (stage === "worker") mocks.bulkDrain.mockRejectedValue(failure);
    if (stage === "report-export") mocks.reportDrain.mockRejectedValue(failure);
    if (stage === "store") mocks.storeClose.mockImplementation(() => { throw failure; });
    if (stage === "pool") mocks.poolEnd.mockRejectedValue(failure);
    signals.get("SIGTERM")!();
    completeHttp!(stage === "http" ? failure : undefined);
    await settle();
    for (const drain of [mocks.dataSyncDrain, ...childDrains]) expect(drain).toHaveBeenCalledOnce();
    expect(mocks.log).toHaveBeenCalledWith("error", "shutdown_failed", { errorCode: "shutdown_failed", errorKind: "unexpected" });
    expect(JSON.stringify(mocks.log.mock.calls)).not.toContain(failure.message);
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
    if (stage !== "pool") expect(mocks.poolEnd).not.toHaveBeenCalled();
  });

  it("bounds a stalled HTTP drain and reports failure instead of a clean shutdown", async () => {
    signals.get("SIGTERM")!();
    await vi.advanceTimersByTimeAsync(124_999);
    expect(process.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(mocks.log).toHaveBeenCalledWith("error", "shutdown_timeout");
    expect(mocks.poolEnd).not.toHaveBeenCalled();
    completeHttp!();
    await settle();
  });
});
