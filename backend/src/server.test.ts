import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  close: vi.fn<(callback?: (error?: Error) => void) => void>(),
  listen: vi.fn(),
  storeClose: vi.fn(),
  poolEnd: vi.fn<() => Promise<void>>(),
  enterMaintenance: vi.fn(),
  loadOperationalState: vi.fn(),
  log: vi.fn(),
  recover: vi.fn(),
  dataSyncDrain: vi.fn<() => Promise<void>>(),
  bulkDrain: vi.fn<() => Promise<void>>(),
  quarantineDrain: vi.fn<() => Promise<void>>(),
  packageDrain: vi.fn<() => Promise<void>>(),
  powerPlatformDrain: vi.fn<() => Promise<void>>(),
  purviewDrain: vi.fn<() => Promise<void>>(),
  defenderDrain: vi.fn<() => Promise<void>>(),
}));
vi.mock("./config.js", () => ({ config: { port: 3001, tenants: [{ tenantId: "tenant-a" }, { tenantId: "tenant-b" }], nodeEnv: "test" }, validateRuntimeConfig: vi.fn() }));
vi.mock("./app.js", () => ({ createApp: () => ({ app: { listen: mocks.listen }, store: { close: mocks.storeClose } }) }));
vi.mock("./db/pool.js", () => ({ pool: { end: mocks.poolEnd, waitingCount: 0 } }));
vi.mock("./db/packageMutationQualifications.js", () => ({ PackageMutationQualificationRepository: class { recoverInterrupted = mocks.recover; } }));
vi.mock("./db/copilotStudioQuarantineCanaries.js", () => ({ CopilotStudioQuarantineCanaryRepository: class { recoverInterrupted = mocks.recover; } }));
vi.mock("./services/bulkJobs.js", () => ({ bulkJobs: { recover: mocks.recover }, drainBulkJobs: mocks.bulkDrain }));
vi.mock("./services/copilotStudioQuarantineJobs.js", () => ({
  copilotStudioQuarantineJobs: { recoverInterrupted: mocks.recover }, drainCopilotStudioQuarantineJobs: mocks.quarantineDrain,
}));
vi.mock("./services/maintenance.js", () => ({ enterMaintenance: mocks.enterMaintenance }));
vi.mock("./services/defenderHunting.js", () => ({ defenderHunting: { recover: mocks.recover, drain: mocks.defenderDrain } }));
vi.mock("./services/dataSync.js", () => ({ dataSync: { recover: mocks.recover, drain: mocks.dataSyncDrain } }));
vi.mock("./services/packageInventory.js", () => ({ packageInventory: { recover: mocks.recover, drain: mocks.packageDrain } }));
vi.mock("./services/powerPlatformInventory.js", () => ({ powerPlatformInventory: { recover: mocks.recover, drain: mocks.powerPlatformDrain } }));
vi.mock("./services/purviewAudit.js", () => ({ purviewAudit: { recover: mocks.recover, drain: mocks.purviewDrain } }));
vi.mock("./services/operationalState.js", () => ({ loadOperationalState: mocks.loadOperationalState }));
vi.mock("./services/telemetry.js", () => ({ operationalLog: mocks.log, observeDatabasePool: vi.fn() }));

const childDrains = [mocks.bulkDrain, mocks.quarantineDrain, mocks.packageDrain, mocks.powerPlatformDrain, mocks.purviewDrain, mocks.defenderDrain];
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
  it("recovers interrupted work for every configured tenant", () => {
    for (const tenantId of ["tenant-a", "tenant-b"]) {
      expect(mocks.recover).toHaveBeenCalledWith(tenantId, true);
      expect(mocks.recover.mock.calls.filter(([tenant]) => tenant === tenantId)).toHaveLength(3);
    }
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

  it.each(["coordinator", "worker", "http", "store", "pool"])("reports %s failures without leaking the error or abandoning other worker drains", async stage => {
    const failure = new Error("Private driver detail must not be logged");
    if (stage === "coordinator") mocks.dataSyncDrain.mockRejectedValue(failure);
    if (stage === "worker") mocks.bulkDrain.mockRejectedValue(failure);
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
