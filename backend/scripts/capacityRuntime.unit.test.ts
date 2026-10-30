import pg from "pg";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataGenerations } from "../src/db/dataGenerations.js";
import { DataSyncService } from "../src/services/dataSync.js";
import { InventoryReconciliation } from "../src/services/inventoryReconciliation.js";
import { InventoryRuntime } from "../src/services/inventoryRuntime.js";
import { PackageInventoryService } from "../src/services/packageInventory.js";
import { PowerPlatformInventoryService } from "../src/services/powerPlatformInventory.js";
import type { DataSyncRun } from "../src/types/dataSync.js";
import type { AuthenticatedUser } from "../src/types/session.js";
import { capacityProvider, fixtureTenant, otherTenant } from "./capacityProvider.js";
import { capacityInitialSync, capacityInput, fixtureFetch } from "./capacityRuntime.js";

vi.mock("../src/db/pool.js", () => ({
  pool: {
    options: { max: 4 },
    query: vi.fn(async () => { throw new Error("Unit tests must not query a database."); }),
    connect: vi.fn(async () => { throw new Error("Unit tests must not connect to a database."); }),
  },
  secretValue: vi.fn((name: string) => name === "SESSION_SECRET" ? "synthetic-capacity-test-session-secret" : undefined),
  transaction: vi.fn(async () => { throw new Error("Unit tests must not access a database."); }),
}));

const databases: pg.Pool[] = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map(database => database.end()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function fixture() {
  vi.stubEnv("AGENT_CONTROL_ISOLATED_TESTS", "1");
  vi.stubEnv("PGHOST", "test-postgres");
  const database = new pg.Pool({ host: "test-postgres", database: `agentcontrol_test_${"a".repeat(32)}`, max: 4 });
  databases.push(database);
  vi.spyOn(database, "query").mockRejectedValue(new Error("Unit tests must not query a database."));
  vi.spyOn(database, "connect").mockRejectedValue(new Error("Unit tests must not connect to a database."));
  const user: AuthenticatedUser = {
    tenantId: fixtureTenant, homeAccountId: "capacity-principal", roles: ["AgentControl.Viewer"],
    displayName: "Capacity fixture", username: "capacity@example.invalid",
  };
  const run: DataSyncRun = {
    id: "capacity-run", mode: "initial", status: "completed", sources: [],
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
  };
  const root = { scopeId: "canonical-scope", tenantId: fixtureTenant, baselineId: "canonical-baseline",
    revision: "1", epoch: "0", inserted: 2, closed: 0, changed: 2 };
  const start = vi.spyOn(DataSyncService.prototype, "start").mockResolvedValue(run);
  const state = vi.spyOn(DataSyncService.prototype, "state").mockResolvedValue({
    run, onboardingRequired: false, usageImportRequired: true, sources: [],
  });
  const syncDrain = vi.spyOn(DataSyncService.prototype, "drain").mockResolvedValue(undefined);
  const packageDrain = vi.spyOn(PackageInventoryService.prototype, "drain").mockResolvedValue(undefined);
  const powerPlatformDrain = vi.spyOn(PowerPlatformInventoryService.prototype, "drain").mockResolvedValue(undefined);
  const enqueue = vi.spyOn(InventoryRuntime.prototype, "enqueue").mockResolvedValue(true);
  const epoch = vi.spyOn(DataGenerations.prototype, "sessionEpoch").mockResolvedValue("7");
  const reconcile = vi.spyOn(InventoryReconciliation.prototype, "runNext").mockResolvedValue(root);
  return { database, user, run, root, start, state, syncDrain, packageDrain, powerPlatformDrain, enqueue, epoch, reconcile };
}

describe("capacity initial sync without infrastructure", () => {
  it("uses initial orchestration and the current actor epoch before returning a canonical publication", async () => {
    const f = fixture();
    await expect(capacityInitialSync(f.database, f.user, 10)).resolves.toMatchObject({
      runId: f.run.id, status: "completed", onboardingRequired: false, canonical: f.root,
    });
    expect(f.start).toHaveBeenCalledExactlyOnceWith(f.user, { mode: "initial" });
    expect(f.enqueue).toHaveBeenCalledExactlyOnceWith({
      tenantId: fixtureTenant, principalId: f.user.homeAccountId,
    }, false);
    expect(f.epoch).toHaveBeenCalledExactlyOnceWith(fixtureTenant, f.user.homeAccountId);
    expect(f.reconcile).toHaveBeenCalledWith(expect.objectContaining({
      scope: { tenantId: fixtureTenant, principalId: null, kind: "tenant", tokenMode: "tenant",
        source: "inventory_canonical", selector: "complete" },
      actorPrincipalId: f.user.homeAccountId, sessionEpoch: "7", jobKind: "derived",
    }), expect.any(Function));
    expect(f.syncDrain).toHaveBeenCalledOnce();
    expect(f.packageDrain).toHaveBeenCalledOnce();
    expect(f.powerPlatformDrain).toHaveBeenCalledOnce();
    expect(f.syncDrain.mock.invocationCallOrder[0]).toBeLessThan(f.packageDrain.mock.invocationCallOrder[0]);
  });

  it.each(["isolation", "environment host", "pool host", "database", "tenant", "count"] as const)(
    "rejects an unsafe %s before starting work", async fault => {
      const f = fixture();
      if (fault === "isolation") vi.stubEnv("AGENT_CONTROL_ISOLATED_TESTS", "0");
      if (fault === "environment host") vi.stubEnv("PGHOST", "other-host.invalid");
      if (fault === "pool host") f.database.options.host = "other-host.invalid";
      if (fault === "database") f.database.options.database = "other-database";
      if (fault === "tenant") f.user.tenantId = "other-tenant";
      await expect(capacityInitialSync(f.database, f.user, fault === "count" ? 100_001 : 10)).rejects.toThrow();
      expect(f.start).not.toHaveBeenCalled();
      expect(f.reconcile).not.toHaveBeenCalled();
    },
  );

  it("drains both child services even when the orchestrator drain fails", async () => {
    const f = fixture(), error = new Error("synthetic sync drain failure");
    f.syncDrain.mockRejectedValue(error);
    await expect(capacityInitialSync(f.database, f.user, 10)).rejects.toMatchObject({ errors: [error] });
    expect(f.packageDrain).toHaveBeenCalledOnce();
    expect(f.powerPlatformDrain).toHaveBeenCalledOnce();
  });

  it("retains the work failure and every cleanup failure", async () => {
    const f = fixture(), primary = new Error("synthetic initial sync failure");
    const sync = new Error("synthetic sync drain failure"), packages = new Error("synthetic package drain failure");
    const powerPlatform = new Error("synthetic Power Platform drain failure");
    f.start.mockRejectedValue(primary);
    f.syncDrain.mockRejectedValue(sync);
    f.packageDrain.mockRejectedValue(packages);
    f.powerPlatformDrain.mockRejectedValue(powerPlatform);
    await expect(capacityInitialSync(f.database, f.user, 10)).rejects.toMatchObject({
      errors: [primary, { errors: [sync, packages, powerPlatform] }],
    });
  });

  it("waits for the other child drain after one child rejects", async () => {
    const f = fixture(), error = new Error("synthetic package drain failure");
    let finish!: () => void;
    f.packageDrain.mockRejectedValue(error);
    f.powerPlatformDrain.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    let settled = false;
    const outcome = capacityInitialSync(f.database, f.user, 10).then(
      value => { settled = true; return value; },
      failure => { settled = true; return failure; },
    );
    try {
      await vi.waitFor(() => expect(f.powerPlatformDrain).toHaveBeenCalledOnce());
      expect(settled).toBe(false);
    } finally {
      finish();
      await outcome;
    }
    expect(await outcome).toMatchObject({ errors: [error] });
  });

  it.each(["start", "state", "reconcile"] as const)("propagates a %s failure after successful cleanup", async stage => {
    const f = fixture(), error = new Error(`synthetic ${stage} failure`);
    f[stage].mockRejectedValue(error);
    await expect(capacityInitialSync(f.database, f.user, 10)).rejects.toBe(error);
    expect(f.syncDrain).toHaveBeenCalledOnce();
    expect(f.packageDrain).toHaveBeenCalledOnce();
    expect(f.powerPlatformDrain).toHaveBeenCalledOnce();
  });

  it("does not claim completion when canonical publication produces no root", async () => {
    const f = fixture();
    f.reconcile.mockResolvedValue(null);
    await expect(capacityInitialSync(f.database, f.user, 10)).rejects.toThrow("Genuine canonical publication must complete");
  });
});

describe("capacity provider transport and inputs", () => {
  it.each([undefined, "33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa"])(
    "maps provider URLs, authorization, cancellation, and workload tenant %s", async tenantId => {
    const upstream = "https://graph.microsoft.com/v1.0/users?$top=100";
    const controller = new AbortController();
    const response = new Response('{"value":[]}', { headers: { "content-type": "application/json" } });
    Object.defineProperty(response, "url", { value: "http://controller:8080/provider" });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetcher);
    const mapped = await fixtureFetch(10, 2, true, "sparse", 10_000,tenantId)(upstream, {
      headers: { Authorization: "synthetic-fixture-token", "x-test": "fixture" }, signal: controller.signal,
    });
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toContain("http://controller:8080/provider?");
    expect(new URL(String(url)).searchParams.get("upstream")).toBe(upstream);
    expect(Object.fromEntries(new URL(String(url)).searchParams)).toMatchObject({
      count: "10", version: "2", opposing: "true", identityProfile: "sparse", children: "10000",
    });
    expect(new URL(String(url)).searchParams.get("tenantId")).toBe(tenantId ?? null);
    expect(init?.headers).toBeInstanceOf(Headers);
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(new Headers(init?.headers).get("x-test")).toBe("fixture");
    expect(init?.signal).toBe(controller.signal);
    expect(init?.redirect).toBe("error");
    expect(mapped.url).toBe(upstream);
    expect(await mapped.json()).toEqual({ value: [] });
  });

  it.each([
    { opposing: false, tenantId: undefined, expected: fixtureTenant },
    { opposing: true, tenantId: undefined, expected: otherTenant },
    { opposing: false, tenantId: "33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa", expected: "33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
  ])("returns native resources for the requested synthetic tenant: $expected", async ({ opposing, tenantId, expected }) => {
    const socket = new Socket(), request = new IncomingMessage(socket), response = new ServerResponse(request);
    const url = new URL("/provider","http://controller:8080");
    url.searchParams.set("upstream","https://api.powerplatform.com/resourcequery/resources/query");
    url.searchParams.set("count","1");
    url.searchParams.set("opposing",String(opposing));
    if (tenantId !== undefined) url.searchParams.set("tenantId",tenantId);
    request.url = url.pathname+url.search;
    request.method = "GET";
    const completed = new Promise<string>(resolve => {
      vi.spyOn(response,"end").mockImplementation((chunk?: unknown) => { resolve(String(chunk)); return response; });
    });
    try {
      capacityProvider().emit("request",request,response);
      const body = JSON.parse(await completed);
      expect(body.data).toHaveLength(1);
      expect(body.data[0]).toMatchObject({ tenantId: expected, name: "native-000000" });
    } finally { request.destroy();socket.destroy(); }
  });

  it("rejects unrelated provider hosts without making a request", () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    expect(() => fixtureFetch(10)("https://other-host.invalid/users")).toThrow("fixture_provider_origin");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["inventory_packages", "inventory_power_platform", "inventory_canonical", "directory"])(
    "keeps %s tenant-owned with separate actor attribution and the existing budget", source => {
      const input = capacityInput("capacity-principal", source);
      expect(input.scope).toEqual({ tenantId: fixtureTenant, principalId: null, kind: "tenant",
        tokenMode: "tenant", source, selector: "complete" });
      expect(input.actorPrincipalId).toBe("capacity-principal");
      expect(input.jobKind).toBe(source === "inventory_canonical" ? "derived" : "fixture");
      expect(input.reserveBytes).toBe((source.startsWith("inventory_") ? 1 : 8) * 1024 ** 3);
    },
  );
});
