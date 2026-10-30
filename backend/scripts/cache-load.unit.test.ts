import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const inventoryPage = () => ({
    value: Array.from({ length: 50 }, () => ({})),
    counts: { total: 1000, filtered: 1000 },
    page: { nextCursor: "next-page" },
  });
  const fixture = {
    operator: { query: vi.fn(async () => ({ rows: [{ bytes: "1024" }] })) },
    runtime: {
      query: vi.fn(async () => ({ rows: [{ count: 2000 }] })),
      totalCount: 4,
      waitingCount: 0,
    },
    close: vi.fn(async () => undefined),
  };
  return {
    fixture,
    open: vi.fn(async () => fixture),
    identity: vi.fn(async () => ({ tenantId: "load-tenant", principalId: "load-principal" })),
    submit: vi.fn(async (_scope: unknown, input: { idempotencyKey: string }) => {
      if (input.idempotencyKey === "cache-load-queue-overflow") {
        throw Object.assign(new Error("Queue limit reached."), { code: "job_limit" });
      }
      return { id: input.idempotencyKey, createdAt: new Date().toISOString() };
    }),
    markRunning: vi.fn(async () => true),
    execute: vi.fn(async (_input: unknown, _intent: unknown, work: (lease: object) => Promise<void>) => {
      await work({});
      return { scopeId: "inventory-scope", baselineId: "inventory-baseline" };
    }),
    stage: vi.fn(async () => undefined),
    inventoryPage,
    page: vi.fn(async () => inventoryPage()),
    now: vi.fn(() => 0),
  };
});

vi.mock("node:perf_hooks", () => ({ performance: { now: mocks.now } }));
vi.mock("./testDatabase.js", () => ({ testDatabase: mocks.open }));
vi.mock("../src/db/packageRefreshJobs.js", () => ({
  PackageRefreshJobs: class {
    submit = mocks.submit;
    markRunning = mocks.markRunning;
  },
}));
vi.mock("../src/db/officialReportImports.js", () => ({
  OfficialReportImports: class {
    stage = mocks.stage;
    async bundle() { return {}; }
    async acceptBundle() {}
  },
}));
vi.mock("../src/services/largeTenantUsersReports.js", () => ({
  LargeTenantUsersReports: class {
    async capture() { return { id: "official-selection" }; }
    async page() {
      return { value: Array.from({ length: 50 }, () => ({})), counts: { total: 250 }, page: { nextCursor: "next-page" } };
    }
  },
}));
vi.mock("../src/services/officialReportExports.js", () => ({
  OfficialReportExports: class {
    inventory = { capture: async () => ({ id: "inventory-selection" }), page: mocks.page };
    engine = { download: async function* () { yield Buffer.from("data"); } };
    async create(_identity: unknown, input: { kind: string }) { return input.kind; }
    async build() {}
    async status(id: string) { return { rows: id === "graph_packages" ? 3000 : 250, bytes: 4 }; }
  },
}));
vi.mock("../src/services/reportIdentity.js", () => ({ reportIdentity: mocks.identity }));
vi.mock("../src/services/packageObservation.js", () => ({ allowlistedPackage: (value: unknown) => value }));
vi.mock("../src/db/inventoryGenerations.js", () => ({
  InventoryGenerations: class {
    execute = mocks.execute;
    async visit() {}
    async appendBounded() {}
    async acceptPage() {}
  },
}));
vi.mock("../src/services/inventoryRecordProjection.js", () => ({ packageInventoryRecord: (value: unknown) => value }));
vi.mock("../src/services/inventoryRuntime.js", () => ({
  inventoryJobInput: async () => ({}),
  completeInventoryJob: () => async () => undefined,
}));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.now.mockReturnValue(0);
  mocks.fixture.runtime.totalCount = 4;
  mocks.fixture.runtime.waitingCount = 0;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("cache load lifecycle without infrastructure", () => {
  it("preserves the workload and emits its receipt only after cleanup succeeds", async () => {
    await import("./cache-load.js");
    expect(mocks.open).toHaveBeenCalledOnce();
    expect(mocks.page).toHaveBeenCalledTimes(120);
    expect(mocks.stage).toHaveBeenCalledTimes(3);
    expect(mocks.submit).toHaveBeenCalledTimes(7);
    expect(mocks.fixture.close).toHaveBeenCalledOnce();
    expect(console.log).toHaveBeenCalledOnce();
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0])).toEqual({
      event: "cache_only_load", outcome: "passed", requests: 120, p95Ms: 0,
      csvRows: 3000, usageRows: 750, queueAccepted: 5, queueRejected: 1,
      poolConnections: 4,
      rssGrowthBytes: expect.any(Number),
      databaseGrowthBytes: 0,
      oldestQueueAgeMs: expect.any(Number),
    });
    expect(mocks.fixture.close.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(console.log).mock.invocationCallOrder[0]);
  });

  it("closes the fixture if the initial database-size query fails", async () => {
    const failure = new Error("Initial measurement failed.");
    mocks.fixture.operator.query.mockRejectedValueOnce(failure);
    await expect(import("./cache-load.js")).rejects.toBe(failure);
    expect(mocks.fixture.close).toHaveBeenCalledOnce();
    expect(mocks.identity).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
  });

  it("drains concurrent readers before cleanup when one reader fails", async () => {
    const failure = new Error("Selected read failed.");
    let release!: (value: ReturnType<typeof mocks.inventoryPage>) => void;
    const pending = new Promise<ReturnType<typeof mocks.inventoryPage>>(resolve => { release = resolve; });
    mocks.page.mockRejectedValueOnce(failure).mockReturnValueOnce(pending);
    const outcome = import("./cache-load.js").then(() => undefined, error => error);
    try {
      await vi.waitFor(() => { expect(mocks.page).toHaveBeenCalledTimes(92); });
      expect(mocks.fixture.close).not.toHaveBeenCalled();
      expect(console.log).not.toHaveBeenCalled();
    } finally {
      release(mocks.inventoryPage());
      await outcome;
    }
    expect(await outcome).toBe(failure);
    expect(mocks.page).toHaveBeenCalledTimes(106);
    expect(mocks.fixture.close).toHaveBeenCalledOnce();
    expect(mocks.stage).not.toHaveBeenCalled();
  });

  it("reports all concurrent read failures after the readers settle", async () => {
    const failures = [new Error("First reader failed."), new Error("Second reader failed.")];
    mocks.page.mockRejectedValueOnce(failures[0]).mockRejectedValueOnce(failures[1]);
    const failure = await import("./cache-load.js").then(() => undefined, error => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors).toEqual(failures);
    expect(mocks.page).toHaveBeenCalledTimes(92);
    expect(mocks.fixture.close).toHaveBeenCalledOnce();
    expect(console.log).not.toHaveBeenCalled();
  });

  it("preserves the workload failure when cleanup also fails", async () => {
    const failure = new Error("Inventory setup failed."), cleanupFailure = new Error("Cleanup failed.");
    mocks.markRunning.mockRejectedValueOnce(failure);
    mocks.fixture.close.mockRejectedValueOnce(cleanupFailure);
    const outcome = await import("./cache-load.js").then(() => undefined, error => error);
    expect(outcome).toBeInstanceOf(AggregateError);
    expect(outcome.errors).toEqual([failure, cleanupFailure]);
    expect(mocks.fixture.close).toHaveBeenCalledOnce();
    expect(console.log).not.toHaveBeenCalled();
  });

  it("never emits a passed receipt when cleanup fails", async () => {
    const failure = new Error("Cleanup failed.");
    mocks.fixture.close.mockRejectedValueOnce(failure);
    await expect(import("./cache-load.js")).rejects.toBe(failure);
    expect(mocks.fixture.close).toHaveBeenCalledOnce();
    expect(console.log).not.toHaveBeenCalled();
  });

  it("retains the strict 2000 ms p95 budget and cleans up on an assertion failure", async () => {
    for (let reader = 0; reader < 8; reader++) mocks.now.mockReturnValueOnce(0);
    mocks.now.mockReturnValue(2000);
    await expect(import("./cache-load.js")).rejects.toThrow("Cache-only p95 2000ms exceeded 2000ms.");
    expect(mocks.fixture.close).toHaveBeenCalledOnce();
    expect(console.log).not.toHaveBeenCalled();
  });

  it("accepts a p95 just below the existing budget", async () => {
    for (let reader = 0; reader < 8; reader++) mocks.now.mockReturnValueOnce(0);
    mocks.now.mockReturnValue(1999);
    await import("./cache-load.js");
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0]).p95Ms).toBe(1999);
    expect(mocks.fixture.close).toHaveBeenCalledOnce();
  });
});
