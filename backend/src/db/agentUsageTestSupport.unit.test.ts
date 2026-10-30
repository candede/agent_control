import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataGenerations, type GenerationLease } from "./dataGenerations.js";
import { InventoryGenerations } from "./inventoryGenerations.js";
import { InventoryReconciliation } from "../services/inventoryReconciliation.js";
import { saveUsageInventory, type UsageGroup } from "./agentUsageTestSupport.js";

afterEach(() => vi.restoreAllMocks());

const scope = { tenantId: "usage-tenant", principalId: "usage-principal" };
const firstId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const secondId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function result(rows: pg.QueryResultRow[] = [], rowCount = rows.length): pg.QueryResult {
  return { command: "SELECT", rowCount, oid: 0, fields: [], rows };
}

function fixture(previous: pg.QueryResultRow[] = []) {
  const database = new pg.Pool({ max: 4 });
  vi.spyOn(database, "connect").mockRejectedValue(new Error("Unit tests must not connect to a database."));
  const query = vi.fn<(statement: unknown, values?: unknown[]) => Promise<pg.QueryResult>>(async statement => {
    if (typeof statement !== "string") throw new Error("Unexpected query shape");
    if (statement.includes("SELECT r.native_id")) return result(previous);
    if (statement.includes("UPDATE inventory_reconciliation")
      || statement.includes("INSERT INTO inventory_canonical_ids")
      || statement.includes("INSERT INTO unified_agent_memberships")) return result([], 1);
    throw new Error(`Unexpected query: ${statement}`);
  });
  vi.spyOn(database, "query").mockImplementation(query);
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  const complete = vi.fn<(statement: unknown, values?: unknown[]) => Promise<pg.QueryResult>>(async statement => {
    if (typeof statement === "string" && statement.includes("UPDATE inventory_reconciliation")) return result([], 1);
    throw new Error(`Unexpected completion query: ${statement}`);
  });
  vi.spyOn(client, "query").mockImplementation(complete);
  const epoch = vi.spyOn(DataGenerations.prototype, "sessionEpoch").mockResolvedValue("7");
  const request = vi.spyOn(InventoryReconciliation.prototype, "request").mockResolvedValue({
    scopeId: "canonical-scope", active: null, pendingSequence: "1",
  });
  const execute = vi.spyOn(InventoryGenerations.prototype, "execute").mockImplementation(async (input, intent, work, options) => {
    const lease: GenerationLease = {
      id: `${intent.domain}-generation`, scopeId: `${intent.domain}-scope`, tenantId: scope.tenantId,
      owner: "owner", version: 1, epoch: "0", sessionEpoch: input.sessionEpoch, expectedRevision: "0", schemaVersion: 1,
    };
    const signal = new AbortController().signal;
    await options.authorize(signal);
    await work(lease, signal);
    await options.completeJob?.(client, { jobId: input.jobId, runId: null, rows: 0, bytes: 0 });
    return { scopeId: lease.scopeId, tenantId: lease.tenantId, baselineId: lease.id,
      revision: "1", epoch: lease.epoch, inserted: 0, closed: 0, changed: 0 };
  });
  const visit = vi.spyOn(InventoryGenerations.prototype, "visit").mockResolvedValue(undefined);
  const appendBounded = vi.spyOn(InventoryGenerations.prototype, "appendBounded").mockResolvedValue(undefined);
  const accept = vi.spyOn(InventoryGenerations.prototype, "acceptPage").mockResolvedValue(undefined);
  const append = vi.spyOn(InventoryGenerations.prototype, "append").mockResolvedValue({ rows: 1, bytes: 0, replay: false });
  return { database, query, complete, epoch, request, execute, visit, appendBounded, accept, append };
}

describe("grouped usage inventory fixtures without a database", () => {
  it("publishes both tenant sources and their canonical memberships with the current actor epoch", async () => {
    const f = fixture();
    const records = await saveUsageInventory(f.database, scope, [
      { canonicalId: firstId, packages: ["Package-A", "Package-B"], native: { nativeId: "Native-A", environmentId: null } },
      { canonicalId: secondId, packages: ["Package-C"] },
    ]);

    expect(records.map(record => record.id)).toEqual([`agent:${firstId}`, `agent:${secondId}`]);
    expect(records.map(record => record.presence)).toEqual(["both", "graph_packages"]);
    expect(f.epoch.mock.calls).toEqual(Array.from({ length: 3 }, () => [scope.tenantId, scope.principalId]));
    expect(f.execute.mock.calls.map(([input, intent]) => ({ scope: input.scope, epoch: input.sessionEpoch, domain: intent.domain })))
      .toEqual(["packages", "power_platform", "canonical"].map(domain => ({
        scope: { tenantId: scope.tenantId, kind: "tenant", principalId: null,
          tokenMode: "tenant", source: `inventory_${domain}`, selector: "complete" },
        epoch: "7", domain,
      })));
    expect(f.visit).toHaveBeenCalledTimes(2);
    expect(f.accept.mock.calls.map(([, page]) => page.rawCount)).toEqual([3, 1]);
    expect(f.append.mock.calls.map(([, rows]) => rows[0].identity)).toEqual([firstId, secondId]);
    const memberships = f.query.mock.calls.filter(([statement]) => String(statement).includes("INSERT INTO unified_agent_memberships"));
    expect(memberships.map(([, values]) => values?.slice(3, 5))).toEqual([
      [firstId, "packages-scope"], [firstId, "packages-scope"], [firstId, "power_platform-scope"], [secondId, "packages-scope"],
    ]);
    expect(f.complete).toHaveBeenCalledOnce();
    expect(f.query.mock.calls.some(([statement]) => String(statement).includes("status='failed'"))).toBe(false);
  });

  it.each(["merge", "split"] as const)("preserves survivor UUIDs through a %s", async change => {
    const f = fixture([
      { native_id: "Package-A", environment_id: null, domain: "packages", agent_id: firstId },
      { native_id: "Package-B", environment_id: null, domain: "packages", agent_id: change === "merge" ? secondId : firstId },
    ]);
    const records = await saveUsageInventory(f.database, scope, change === "merge"
      ? [{ packages: ["Package-A", "Package-B"] }]
      : [{ packages: ["Package-A"] }, { packages: ["Package-B"] }]);

    expect(records[0].id).toBe(`agent:${firstId}`);
    expect(new Set(records.map(record => record.id)).size).toBe(records.length);
  });

  it.each([
    { groups: Array.from({ length: 251 }, () => ({ packages: [] })) },
    { groups: [{ packages: Array.from({ length: 251 }, (_, index) => `Package-${index}`) }] },
  ] satisfies { groups: UsageGroup[] }[])("rejects oversized fixtures before publication: %#", async ({ groups }) => {
    const f = fixture();
    await expect(saveUsageInventory(f.database, scope, groups)).rejects.toThrow("small synthetic fixtures");
    expect(f.epoch).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalled();
  });

  it("propagates a source failure without claiming canonical work", async () => {
    const f = fixture(), failure = new Error("Source publication failed");
    f.execute.mockRejectedValueOnce(failure);
    await expect(saveUsageInventory(f.database, scope)).rejects.toBe(failure);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalled();
  });

  it("restores retryable reconciliation inputs after canonical publication fails", async () => {
    const f = fixture(), failure = new Error("Canonical publication failed");
    f.append.mockRejectedValueOnce(failure);

    await expect(saveUsageInventory(f.database, scope)).rejects.toBe(failure);
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.query).toHaveBeenLastCalledWith(expect.stringMatching(
      /UPDATE inventory_reconciliation SET active_id=NULL,active_until=NULL,active_deadline=NULL,\s*pending_inputs=coalesce\(pending_inputs,active_inputs\),status='failed' WHERE scope_id=\$1 AND active_id=\$2/,
    ), ["canonical-scope", f.execute.mock.calls[2][0].jobId]);
  });

  it("reports both the publication error and a reconciliation cleanup error", async () => {
    const f = fixture(), failure = new Error("Canonical publication failed"), cleanup = new Error("Cleanup failed");
    f.append.mockRejectedValueOnce(failure);
    const executeQuery = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (statement, values) => {
      if (String(statement).includes("status='failed'")) throw cleanup;
      return executeQuery(statement, values);
    });

    await expect(saveUsageInventory(f.database, scope)).rejects.toMatchObject({
      message: "inventory_reconciliation_and_cleanup_failed", errors: [failure, cleanup],
    });
  });

  it("rejects completion after losing the reconciliation claim", async () => {
    const f = fixture();
    f.complete.mockResolvedValueOnce(result([], 0));
    await expect(saveUsageInventory(f.database, scope)).rejects.toThrow("inventory_reconciliation_fenced");
  });

  it("keeps a concurrently queued reconciliation pending on successful completion", async () => {
    const f = fixture();
    await saveUsageInventory(f.database, scope);
    expect(f.complete).toHaveBeenCalledWith(expect.stringContaining(
      "status=CASE WHEN pending_inputs IS NULL THEN 'idle' ELSE 'catching_up' END",
    ), ["canonical-scope", f.execute.mock.calls[2][0].jobId]);
  });
});
