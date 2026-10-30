import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ProfileClient = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

const mocks = vi.hoisted(() => {
  const fixture = {
    operator: { query: vi.fn(async () => ({ rows: [] })) },
    runtime: { on: vi.fn() },
    close: vi.fn(async () => undefined),
  };
  const client = { query: vi.fn(async (_sql: string, _values?: unknown[]): ReturnType<ProfileClient["query"]> => ({ rows: [] })) };
  return {
    fixture, client, clock: 0,
    open: vi.fn(async () => fixture),
    construct: vi.fn(),
    capture: vi.fn(async () => {
      mocks.clock += 100;
      return { id: "profile-selection" };
    }),
    page: vi.fn(async () => {
      mocks.clock += 20;
      return { counts: { total: 3, filtered: 3 } };
    }),
    exact: vi.fn(async () => { mocks.clock += 5; }),
    ensure: vi.fn(async () => undefined),
    accepted: vi.fn(async () => undefined),
    prepareRead: vi.fn(async () => undefined),
    seedUnion: vi.fn(async () => ({ id: "large-set" })),
    seedSet: vi.fn(async () => ({ id: "small-set", versions: { users: "small-users" } })),
    seedUser: vi.fn(async () => undefined),
  };
});

vi.mock("node:perf_hooks", () => ({ performance: { now: () => mocks.clock } }));
vi.mock("./testDatabase.js", () => ({ testDatabase: mocks.open }));
vi.mock("./officialReportFixtures.js", () => ({
  seedDisjointReportUnion: mocks.seedUnion, seedReportSet: mocks.seedSet, seedUserFact: mocks.seedUser,
}));
vi.mock("./largeTenantFixtures.js", () => ({
  selectionIdentity: { tenantId: "profile-tenant", principalId: "profile-actor", sessionEpoch: "0", authorizationHash: "profile-auth" },
}));
vi.mock("../src/services/largeTenantUsersReports.js", () => ({
  LargeTenantUsersReports: class {
    constructor() { mocks.construct(); }
    capture = mocks.capture;
    page = mocks.page;
    exact = mocks.exact;
    history = {
      ensure: mocks.ensure, accepted: mocks.accepted, prepareRead: mocks.prepareRead,
      connections: { run: async <T>(work: (client: typeof mocks.client) => Promise<T>) => work(mocks.client) },
    };
    selections = {
      connections: { selectedRead: async <T>(work: (client: typeof mocks.client) => Promise<T>) => work(mocks.client) },
    };
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.clock = 0;
  vi.spyOn(console, "log").mockImplementation(() => { mocks.clock += 7; });
});
afterEach(() => { vi.restoreAllMocks(); });

describe("report read profiling without infrastructure", () => {
  it("measures each read independently of capture and output time", async () => {
    await import("./reportReadProfile.js");
    const calls = vi.mocked(console.log).mock.calls;
    for (const [label, expected, count] of [
      ["CAPTURE_MS", 100, 2], ["PAGE_MS", 20, 2], ["EXACT_MS", 5, 2],
      ["SMALL_CAPTURE_MS", 100, 4], ["SMALL_PAGE_MS", 20, 4],
    ] as const) {
      const measurements = calls.filter(call => call[0] === label);
      expect(measurements, label).toHaveLength(count);
      expect(measurements.map(call => call[2]), label).toEqual(Array(count).fill(expected));
    }
    expect(mocks.seedUnion).toHaveBeenCalledWith(mocks.fixture.operator, expect.any(String), 50000);
    expect(mocks.capture).toHaveBeenCalledTimes(6);
    expect(mocks.page).toHaveBeenCalledTimes(6);
    expect(mocks.exact).toHaveBeenCalledTimes(2);
    expect(mocks.seedUser).toHaveBeenCalledTimes(3);
    expect(mocks.fixture.close).toHaveBeenCalledOnce();
  });

  it("keeps the slowest query parameters and explains only the four slowest distinct statements", async () => {
    let acquire: ((client: ProfileClient) => void) | undefined;
    mocks.fixture.runtime.on.mockImplementationOnce((_event: string, listener: typeof acquire) => { acquire = listener; });
    const query = vi.fn(async (sql: string, values?: unknown[]): ReturnType<ProfileClient["query"]> => {
      if (sql.startsWith("EXPLAIN")) return { rows: [{ "QUERY PLAN": [{ Plan: { "Node Type": "Result" } }] }] };
      mocks.clock += Number(values?.[0]);
      return { rows: [] };
    });
    const client: ProfileClient = { query };
    mocks.page.mockImplementation(async () => {
      if (!acquire) throw new Error("profile_query_listener_missing");
      acquire(client);
      await client.query("SELECT $1::integer AS fast", [29]);
      for (let index = 0; index < 22; index++) await client.query(`SELECT $1::integer AS metric_${index}`, [30 + index]);
      await client.query("SELECT $1::integer AS metric_21", [30]);
      await client.query("SELECT $1::integer AS metric_0", [99]);
      return { counts: { total: 3, filtered: 3 } };
    });
    mocks.client.query.mockResolvedValue({ rows: [{ "QUERY PLAN": [{ Plan: { "Node Type": "Result" } }] }] });

    await import("./reportReadProfile.js");

    expect(mocks.client.query.mock.calls).toEqual([
      ["EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT $1::integer AS metric_0", [99]],
      ["EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT $1::integer AS metric_21", [51]],
      ["EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT $1::integer AS metric_20", [50]],
      ["EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT $1::integer AS metric_19", [49]],
    ]);
    expect(vi.mocked(console.log).mock.calls.filter(call => call[0] === "QUERY_MS").every(call => !String(call[3]).includes("fast"))).toBe(true);
    expect(vi.mocked(console.log).mock.calls.filter(call => call[0] === "EXPLAIN")).toHaveLength(4);
    expect(mocks.prepareRead).toHaveBeenCalledTimes(4);
    expect(mocks.prepareRead).toHaveBeenCalledWith(mocks.client, expect.stringMatching(/^native-small-/));
    expect(mocks.fixture.close).toHaveBeenCalledOnce();
  });

  it.each([1048576, 1048577])("enforces the explain output byte limit at %i bytes", async bytes => {
    let acquire: ((client: ProfileClient) => void) | undefined;
    mocks.fixture.runtime.on.mockImplementationOnce((_event: string, listener: typeof acquire) => { acquire = listener; });
    const client: ProfileClient = { query: async () => { mocks.clock += 30; return { rows: [] }; } };
    mocks.page.mockImplementation(async () => {
      if (!acquire) throw new Error("profile_query_listener_missing");
      acquire(client);
      await client.query("SELECT 1");
      return { counts: { total: 3, filtered: 3 } };
    });
    const plan = { Plan: { detail: "" } };
    plan.Plan.detail = "x".repeat(bytes - Buffer.byteLength(JSON.stringify(plan)));
    mocks.client.query.mockResolvedValue({ rows: [{ "QUERY PLAN": [plan] }] });

    if (bytes <= 1048576) {
      await import("./reportReadProfile.js");
      expect(vi.mocked(console.log).mock.calls.filter(call => call[0] === "EXPLAIN")).toHaveLength(1);
    } else {
      await expect(import("./reportReadProfile.js")).rejects.toThrow("profile_result_bytes");
      expect(vi.mocked(console.log).mock.calls.filter(call => call[0] === "EXPLAIN")).toHaveLength(0);
    }
    expect(mocks.fixture.close).toHaveBeenCalledOnce();
  });

  it("closes the fixture if report service construction fails", async () => {
    const error = new Error("synthetic report initialization failure");
    mocks.construct.mockImplementationOnce(() => { throw error; });
    await expect(import("./reportReadProfile.js")).rejects.toBe(error);
    expect(mocks.fixture.close).toHaveBeenCalledOnce();
    expect(mocks.seedUnion).not.toHaveBeenCalled();
  });

  it("preserves workload and cleanup failures together", async () => {
    const workload = new Error("synthetic seed failure"), cleanup = new Error("synthetic cleanup failure");
    mocks.seedUnion.mockRejectedValueOnce(workload);
    mocks.fixture.close.mockRejectedValueOnce(cleanup);
    const failure = await import("./reportReadProfile.js").then(() => undefined, error => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors).toEqual([workload, cleanup]);
    expect(mocks.fixture.close).toHaveBeenCalledOnce();
  });

  it("propagates a workload failure after successful cleanup", async () => {
    const error = new Error("synthetic capture failure");
    mocks.capture.mockRejectedValueOnce(error);
    await expect(import("./reportReadProfile.js")).rejects.toBe(error);
    expect(mocks.page).not.toHaveBeenCalled();
    expect(mocks.fixture.close).toHaveBeenCalledOnce();
  });

  it("reports a cleanup failure even after a successful workload", async () => {
    const error = new Error("synthetic cleanup failure");
    mocks.fixture.close.mockRejectedValueOnce(error);
    await expect(import("./reportReadProfile.js")).rejects.toBe(error);
    expect(mocks.page).toHaveBeenCalledTimes(6);
    expect(mocks.fixture.close).toHaveBeenCalledOnce();
  });

  it("does not construct reports when fixture initialization fails", async () => {
    const error = new Error("synthetic fixture failure");
    mocks.open.mockRejectedValueOnce(error);
    await expect(import("./reportReadProfile.js")).rejects.toBe(error);
    expect(mocks.construct).not.toHaveBeenCalled();
    expect(mocks.fixture.close).not.toHaveBeenCalled();
  });
});
