import pg from "pg";
import { setTimeout as delay } from "node:timers/promises";
import type { TimerOptions } from "node:timers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capacityIdentityProbe, fullCapacity } from "./capacityWorkloads.js";
import { capacityInput } from "./capacityRuntime.js";
import { fixtureTenant } from "./capacityProvider.js";
import { CapacityTelemetry } from "./capacityTelemetry.js";
import { physicalWork } from "./capacityPhysicalWork.js";
import { StreamedInventory } from "../src/services/streamedInventory.js";
import { UserSourceProvider } from "../src/services/userSourceProvider.js";
import { InventoryReconciliation } from "../src/services/inventoryReconciliation.js";
import { InventoryQueries } from "../src/db/inventoryQueries.js";
import { InventoryGenerations } from "../src/db/inventoryGenerations.js";
import { DataGenerations, type BeginGeneration } from "../src/db/dataGenerations.js";
import { OfficialReportImports } from "../src/db/officialReportImports.js";
import { LargeTenantUsersReports } from "../src/services/largeTenantUsersReports.js";
import { DataSelections, type Selection } from "../src/services/dataSelections.js";

vi.mock("../src/db/pool.js", () => ({
  pool: { options: { max: 4 } },
  secretValue: vi.fn((name: string) => name === "SESSION_SECRET" ? "synthetic-capacity-test-session-secret" : undefined),
}));
vi.mock("./capacityTelemetry.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./capacityTelemetry.js")>();
  return { ...actual, CapacityTelemetry: class {
    write = vi.fn();
    capturePlans = vi.fn(async () => {});
  } };
});
vi.mock("./capacityPhysicalWork.js", () => ({
  capacityOperation: (_name: string, work: () => Promise<unknown>) => work(),
  physicalWork: vi.fn(async () => ({
    checkpoint: vi.fn(async () => {}),
    flush: vi.fn(async () => ({ transactions: 1, sequentialTuples: 1, indexTuples: 0 })),
    close: vi.fn(async () => {}),
  })),
}));
vi.mock("./capacityHttp.js", () => ({ capacityHttp: vi.fn(async () => { throw new Error("unrelated HTTP workload"); }) }));
vi.mock("./backup.js", () => ({ backup: vi.fn(), restore: vi.fn() }));
vi.mock("node:child_process", () => ({ fork: vi.fn(() => { throw new Error("unit tests must not start workers"); }) }));
vi.mock("../src/db/dataConnections.js", () => ({
  dataConnections: (database: pg.Pool) => ({ run: (work: (client: pg.Pool) => Promise<unknown>) => work(database) }),
}));
vi.mock("../src/db/dataRetention.js", () => ({ retainRecordData: vi.fn(async () => {}) }));
vi.mock("node:timers/promises", async importOriginal => ({
  ...await importOriginal<typeof import("node:timers/promises")>(), setTimeout: vi.fn(),
}));

const databases: pg.Pool[] = [];
const unrelated = new Error("unrelated workload");
beforeEach(() => {
  vi.mocked(delay).mockImplementation(async <T>(_milliseconds?: number, value?: T): Promise<T> => {
    await new Promise<void>(resolve => setImmediate(resolve));
    return value!;
  });
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(unrelated));
  vi.spyOn(StreamedInventory.prototype, "graphCatalog").mockRejectedValue(unrelated);
  vi.spyOn(StreamedInventory.prototype, "powerPlatformCatalog").mockRejectedValue(unrelated);
  vi.spyOn(StreamedInventory.prototype, "details").mockRejectedValue(unrelated);
  vi.spyOn(StreamedInventory.prototype, "exact").mockRejectedValue(unrelated);
  vi.spyOn(UserSourceProvider.prototype, "refresh").mockRejectedValue(unrelated);
  vi.spyOn(InventoryReconciliation.prototype, "request").mockRejectedValue(unrelated);
  vi.spyOn(InventoryReconciliation.prototype, "runNext").mockRejectedValue(unrelated);
  vi.spyOn(InventoryGenerations.prototype, "execute").mockRejectedValue(unrelated);
  vi.spyOn(DataGenerations.prototype, "execute").mockRejectedValue(unrelated);
  vi.spyOn(OfficialReportImports.prototype, "stage").mockRejectedValue(unrelated);
  vi.spyOn(LargeTenantUsersReports.prototype, "capture").mockRejectedValue(unrelated);
  vi.spyOn(InventoryQueries.prototype, "capture").mockRejectedValue(unrelated);
  vi.spyOn(DataSelections.prototype, "invalidate").mockResolvedValue(undefined);
});
afterEach(async () => {
  await Promise.all(databases.splice(0).map(database => database.end()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture() {
  const database = new pg.Pool();
  databases.push(database);
  const query = vi.spyOn(database, "query").mockRejectedValue(new Error("unit tests must not query a database"));
  vi.spyOn(database, "connect").mockRejectedValue(new Error("unit tests must not connect to a database"));
  const telemetry = new CapacityTelemetry("unused");
  let stage = "";
  vi.mocked(telemetry.write).mockImplementation(value => {
    if (value && typeof value === "object" && "event" in value && value.event === "stage-start" && "name" in value) {
      stage = String(value.name);
    }
  });
  return { database, query, telemetry, stage: () => stage };
}
function root(input: BeginGeneration) {
  return { tenantId: input.scope.tenantId, scopeId: `${input.scope.tenantId}:${input.scope.source}`,
    baselineId: `${input.scope.source}-baseline`, revision: "1", epoch: "0", inserted: 20, closed: 20, changed: 20 };
}
function selection(id: string): Selection {
  const now = new Date();
  return { id, revision: "1", expiresAt: new Date(now.getTime()+3600_000), evaluatedAt: now, validatedAt: now,
    endpoint: "inventory", queryHash: "synthetic-query" };
}

describe("capacity workload tenant ownership without infrastructure", () => {
  it("keeps the fixed physical probe out of the main tenant while preserving tenant-owned source scopes", async () => {
    const f = fixture();
    f.query.mockImplementation(async () => ({
      rows: [{ lsn: "0/1", bytes: "1" }], rowCount: 1, command: "SELECT", oid: 0, fields: [],
    }));
    vi.mocked(StreamedInventory.prototype.graphCatalog).mockImplementation(async input => root(input));
    vi.mocked(StreamedInventory.prototype.details).mockImplementation(async input => root(input));
    vi.mocked(StreamedInventory.prototype.powerPlatformCatalog).mockImplementation(async input => root(input));
    vi.mocked(InventoryReconciliation.prototype.request).mockImplementation(async input => ({
      scopeId: root(input).scopeId, active: null, pendingSequence: "1",
    }));
    vi.mocked(InventoryReconciliation.prototype.runNext).mockImplementation(async input => root(input));

    const result = await capacityIdentityProbe(f.database, f.telemetry);
    expect(result.root.tenantId).not.toBe(fixtureTenant);
    expect(result.canonical?.tenantId).toBe(result.root.tenantId);
    const catalog = vi.mocked(StreamedInventory.prototype.graphCatalog).mock.calls[0][0];
    expect(catalog.scope).toMatchObject({ tenantId: result.root.tenantId, kind: "tenant", principalId: null,
      tokenMode: "tenant", selector: "complete" });
    expect(vi.mocked(StreamedInventory.prototype.details).mock.calls.every(([input]) =>
      input.scope.tenantId === result.root.tenantId)).toBe(true);
    expect(StreamedInventory.prototype.powerPlatformCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ scope: expect.objectContaining({ tenantId: result.root.tenantId }) }),
      "synthetic", ["microsoft.copilotstudio/agents"],
      expect.objectContaining({ expectedTenantId: result.root.tenantId }),
    );
  });

  it("finds tenant-owned detail scopes and verifies retention without replacing the main inventory", async () => {
    const f = fixture(), inputs: BeginGeneration[] = [];
    vi.mocked(StreamedInventory.prototype.graphCatalog).mockImplementation(async input => {
      if (f.stage() !== "100k-uniform-sparse-detail-baseline") throw unrelated;
      inputs.push(input); return root(input);
    });
    vi.mocked(StreamedInventory.prototype.powerPlatformCatalog).mockImplementation(async input => {
      if (f.stage() !== "100k-uniform-sparse-detail-baseline") throw unrelated;
      inputs.push(input); return root(input);
    });
    vi.mocked(InventoryReconciliation.prototype.request).mockImplementation(async input => {
      if (f.stage() !== "100k-uniform-sparse-detail-baseline") throw unrelated;
      inputs.push(input); return { scopeId: root(input).scopeId, active: null, pendingSequence: "1" };
    });
    vi.mocked(InventoryReconciliation.prototype.runNext).mockImplementation(async input => root(input));
    vi.mocked(InventoryQueries.prototype.capture).mockImplementation(async (identity, scopeId) => {
      expect(scopeId).toBe(`${identity.tenantId}:inventory_packages`);
      return selection("current-detail");
    });
    vi.spyOn(InventoryQueries.prototype, "exact").mockImplementation(async (_id, _identity, ids) =>
      ids.map(identity => ({ identity })));
    vi.spyOn(InventoryGenerations.prototype, "gcSlice").mockResolvedValue({ rows: 0, removed: 0, bytes: 0 });
    vi.spyOn(InventoryGenerations.prototype, "gcContent").mockResolvedValue({ rows: 0, bytes: 0 });
    vi.spyOn(InventoryGenerations.prototype, "gcMetadata").mockResolvedValue({});
    f.query.mockImplementation(async (sql, parameters) => {
      const text = String(sql);
      let rows: Record<string, unknown>[];
      if (text.startsWith("SELECT row_count")) rows = [{ row_count: 200_000 }];
      else if (text.includes("FROM data_read_selections") || text.includes("FROM data_exports")) rows = [];
      else if (text.includes("SELECT id,source FROM data_scope_epochs")) {
        rows = text.includes("principal_id=$2") ? [] : inputs.map(input => ({
          id: root(input).scopeId, source: input.scope.source,
        }));
        expect(parameters?.[0]).toBe(inputs[0].scope.tenantId);
      } else if (text.includes("SELECT baseline_id,scope_id FROM inventory_roots")) rows = [];
      else if (text.includes("AS scope_charge_mismatches")) {
        rows = [{ intervals: "0", collected_quota_errors: "0", quota_mismatches: "0", scope_charge_mismatches: "0",
          reserved_bytes: "10" }];
      } else if (text.includes("WITH keys AS MATERIALIZED")) rows = [];
      else throw new Error(`unexpected unit query: ${text}`);
      return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
    });

    const receipts = await fullCapacity(f.database, f.telemetry);
    expect(receipts.find(receipt => receipt.name === "post-detail-pin-release-and-ten-minute-retention"))
      .toMatchObject({ status: "passed", result: { remaining: { intervals: "0", unreferenced_keys: "0" } } });
    expect(inputs).toHaveLength(3);
    expect(new Set(inputs.map(input => input.scope.tenantId)).size).toBe(1);
    expect(inputs[0].scope.tenantId).not.toBe(capacityInput("capacity-main").scope.tenantId);
    expect(InventoryQueries.prototype.capture).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: inputs[0].scope.tenantId, principalId: "capacity-detail" }),
      `${inputs[0].scope.tenantId}:inventory_packages`,
    );
    expect(DataSelections.prototype.invalidate).toHaveBeenCalledWith(
      "current-detail", expect.objectContaining({ tenantId: inputs[0].scope.tenantId }),
    );
    expect(physicalWork).toHaveBeenCalled();
  });

  it.each([
    { name: "successful readers", readError: false, workError: false, releaseError: false, rotate: false },
    { name: "failed readers", readError: true, workError: false, releaseError: false, rotate: false },
    { name: "work and reader failures", readError: true, workError: true, releaseError: false, rotate: false },
    { name: "selection cleanup failure", readError: false, workError: false, releaseError: true, rotate: false },
    { name: "one shared selection rotation", readError: false, workError: false, releaseError: false, rotate: true },
  ])("records $name truthfully and releases heartbeat selections after readers stop", async fault => {
    const f = fixture();
    let clock = Date.now(), longWaits = 0, published = false, captures = 0;
    const timeOrigin = clock;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    vi.spyOn(performance, "now").mockImplementation(() => clock-timeOrigin);
    vi.mocked(delay).mockImplementation(async <T>(milliseconds = 0, value?: T, options?: TimerOptions): Promise<T> => {
      if (milliseconds === 600_000 && ++longWaits === 2) {
        await new Promise<void>((_resolve, reject) => {
          const signal = options!.signal!;
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      } else if (milliseconds >= 1000) clock += milliseconds;
      await new Promise<void>(resolve => setImmediate(resolve));
      return value!;
    });
    const baseline = async (input: BeginGeneration) => {
      if (f.stage() !== "100k-graph-and-power-platform") throw unrelated;
      return root(input);
    };
    vi.mocked(StreamedInventory.prototype.graphCatalog).mockImplementation(baseline);
    vi.mocked(StreamedInventory.prototype.details).mockImplementation(baseline);
    vi.mocked(StreamedInventory.prototype.powerPlatformCatalog).mockImplementation(baseline);
    vi.mocked(InventoryQueries.prototype.capture).mockImplementation(async () => {
      if (f.stage() !== "600-second-retry-heartbeat-cancellation") throw unrelated;
      const selected = selection(`heartbeat-pin-${++captures}`);
      if (fault.rotate && captures === 1) selected.expiresAt = new Date(clock+1000);
      return selected;
    });
    vi.spyOn(InventoryQueries.prototype, "exact").mockImplementation(async (_id, _identity, ids) => {
      if (fault.readError) throw new Error("synthetic heartbeat reader failure");
      return ids.map(identity => ({ identity }));
    });
    if (fault.releaseError) vi.mocked(DataSelections.prototype.invalidate).mockRejectedValue(new Error("synthetic selection release failure"));
    vi.spyOn(DataGenerations.prototype, "renew").mockResolvedValue(undefined);
    vi.spyOn(InventoryGenerations.prototype, "validate").mockResolvedValue(undefined);
    vi.spyOn(InventoryGenerations.prototype, "visit").mockResolvedValue(undefined);
    vi.spyOn(InventoryGenerations.prototype, "acceptPage").mockResolvedValue(undefined);
    vi.mocked(InventoryGenerations.prototype.execute).mockImplementation(async function (
      this: InventoryGenerations, input, _intent, work, options,
    ) {
      if (f.stage() !== "600-second-retry-heartbeat-cancellation") throw unrelated;
      if (fault.workError) throw new Error("synthetic heartbeat work failure");
      const lease = { id: input.actorPrincipalId!, scopeId: root(input).scopeId, tenantId: input.scope.tenantId,
        owner: "synthetic-owner", version: 1, epoch: "0", sessionEpoch: "0", expectedRevision: "0", schemaVersion: 1 };
      await work(lease, options.signal ?? new AbortController().signal);
      for (let renewal = 0; renewal < 30; renewal++) await this.generations.renew(lease);
      const validation = this.validate(lease);
      await Promise.resolve();
      await this.generations.renew(lease);
      await validation;
      published = true;
      return root(input);
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async input => {
      expect(f.stage()).toBe("600-second-retry-heartbeat-cancellation");
      const retry = new URL(String(input)).searchParams.has("retry");
      return retry ? new Response('{"error":{"code":"TooManyRequests"}}', { status: 429, headers: { "Retry-After": "600" } })
        : new Response('{"value":[],"@odata.count":0}', { headers: { "content-type": "application/json" } });
    }));
    f.query.mockImplementation(async sql => {
      if (f.stage() !== "600-second-retry-heartbeat-cancellation") throw unrelated;
      const rows = [{ state: String(sql).includes("lease_until") ? "cancelled" : published ? "published" : "validating",
        row_count: 0, batch_count: 0 }];
      return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
    });

    const receipts = await fullCapacity(f.database, f.telemetry);
    const receipt = receipts.find(value => value.name === "600-second-retry-heartbeat-cancellation");
    expect(receipt).toMatchObject({ status: fault.readError || fault.workError || fault.releaseError ? "failed" : "passed" });
    if (fault.readError) expect(JSON.stringify(receipt?.error)).toContain("capacity_heartbeat_reader_failure");
    if (fault.workError) expect(JSON.stringify(receipt?.error)).toContain("synthetic heartbeat work failure");
    if (fault.releaseError) expect(JSON.stringify(receipt?.error)).toContain("synthetic selection release failure");
    expect(captures).toBe(fault.rotate ? 2 : 1);
    for (let index = 1; index <= captures; index++) expect(DataSelections.prototype.invalidate).toHaveBeenCalledWith(
      `heartbeat-pin-${index}`, expect.objectContaining({ tenantId: fixtureTenant, principalId: "capacity-main" }));
    expect(vi.mocked(InventoryGenerations.prototype.execute).mock.calls
      .filter(([input]) => ["capacity-idle", "capacity-cancel"].includes(input.actorPrincipalId ?? ""))
      .every(([input]) => input.scope.tenantId !== fixtureTenant)).toBe(true);
  });
});
