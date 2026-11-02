import pg from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { retain, retainUntilConverged } from "./database.js";
import { LifecycleSlice } from "../src/db/lifecycleSlice.js";
import { auditOriginIntegritySql } from "../src/db/auditOriginSchema.js";
import * as metrics from "../src/services/dataMetrics.js";

vi.mock("../src/db/schema.js", async original => ({
  ...await original<typeof import("../src/db/schema.js")>(), verifySchema: vi.fn(async () => undefined),
}));

afterEach(() => { metrics.flushDataWorkMetrics(); vi.restoreAllMocks(); });

function retentionFixture() {
  const database = new pg.Pool({ max: 4 });
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  vi.spyOn(database, "connect").mockImplementation(async () => client);
  vi.spyOn(database, "query").mockRejectedValue(new Error("Unexpected pool query."));
  const change = vi.spyOn(LifecycleSlice.prototype, "change").mockResolvedValue(0);
  const result = (rows: object[] = []) => ({ command: "", oid: 0, fields: [], rowCount: rows.length, rows });
  const query = vi.spyOn(client, "query").mockImplementation(async statement => {
    if (typeof statement !== "string") throw new Error("Unexpected query shape.");
    if (statement === "COMMIT") return { ...result(), command: "COMMIT" };
    if (statement.includes("pg_try_advisory_xact_lock") || statement.includes("pg_try_advisory_lock_shared")) return result([{ acquired: true }]);
    if (statement.includes("pg_advisory_unlock_shared")) return result([{ unlocked: true }]);
    if (statement.startsWith("SELECT cursor->>'step'")) return result([{ step: "0" }]);
    if (statement.startsWith("SELECT count(*)::text AS roots")) return result([{ roots: "0", age: "0" }]);
    if (statement.startsWith("SELECT to_regclass")) return result([{ name: null }]);
    if (statement.startsWith("SELECT cursor FROM")) return result([{ cursor: {} }]);
    if (statement.startsWith("SELECT id,kind,status") || statement.startsWith("SELECT tenant_id FROM")) return result();
    if (["BEGIN", "ROLLBACK"].includes(statement) || statement.startsWith("SET LOCAL")
      || statement.startsWith("UPDATE data_lifecycle_progress")) return result();
    throw new Error("Unexpected operator query.");
  });
  return { database, client, query, change };
}

it("retains linked job provenance until bounded mutation-stage cleanup removes the stage", async () => {
  const { database, change } = retentionFixture();
  expect(auditOriginIntegritySql).toContain("to_jsonb(OLD)->>'job_id' IS NOT NULL");
  expect(auditOriginIntegritySql).toContain("to_jsonb(NEW)->>'job_id' IS DISTINCT FROM to_jsonb(OLD)->>'job_id'");
  change.mockImplementation(async (_name, table, _where, values) => {
    if (table === "inventory_mutation_stages" && values?.includes("job_id=NULL")) throw new Error("action_origin_immutable");
    return 0;
  });
  await expect(retain(database)).resolves.toMatchObject({ dryRun: false });
  expect(change).toHaveBeenCalledWith("inventoryMutationStages", "inventory_mutation_stages",
    expect.stringContaining("NOT EXISTS(SELECT 1 FROM inventory_mutation_targets"));
  expect(change).toHaveBeenCalledWith("jobs", "jobs",
    expect.stringContaining("NOT EXISTS(SELECT 1 FROM inventory_mutation_stages s WHERE s.job_id=target.id)"));
});

it.each([false, true])("discards a client and preserves both failures when retention rollback fails (converged=%s)", async converged => {
  const { database, client, query, change } = retentionFixture();
  const primary = new Error("Synthetic retention failure.");
  const rollback = new Error("Synthetic rollback failure.");
  change.mockRejectedValue(primary);
  const original = query.getMockImplementation()!;
  query.mockImplementation(async (...args) => {
    if (args[0] === "ROLLBACK") throw rollback;
    return Reflect.apply(original, client, args);
  });
  const pending = converged ? retainUntilConverged(database) : retain(database);
  await expect(pending).rejects.toMatchObject({ errors: [primary, rollback] });
  expect(query).not.toHaveBeenCalledWith("COMMIT");
  expect(client.release).toHaveBeenCalledOnce();
  expect(client.release.mock.calls[0][0]).toBeTruthy();
});

it.each([false, true])("handles checked-out client errors without reporting a successful commit (converged=%s)", async converged => {
  const { database, client, query } = retentionFixture();
  const primary = new Error("Synthetic checked-out client failure.");
  const original = query.getMockImplementation()!;
  query.mockImplementation(async (...args) => {
    if (args[0] === "SELECT cursor FROM data_lifecycle_progress WHERE worker='operator'") {
      client.emit("error", primary);
    }
    return Reflect.apply(original, client, args);
  });
  const pending = converged ? retainUntilConverged(database) : retain(database);
  await expect(pending).rejects.toBe(primary);
  expect(query).toHaveBeenCalledWith("ROLLBACK");
  expect(query).not.toHaveBeenCalledWith("COMMIT");
  expect(client.release.mock.calls[0][0]).toBeTruthy();
});

it("preserves the slice failure when releasing the shared schema lock also fails", async () => {
  const { database, client, query, change } = retentionFixture();
  const primary = new Error("Synthetic retention failure.");
  const unlock = new Error("Synthetic unlock failure.");
  change.mockRejectedValue(primary);
  const original = query.getMockImplementation()!;
  query.mockImplementation(async (...args) => {
    if (args[0] === "SELECT pg_advisory_unlock_shared(3650101) AS unlocked") throw unlock;
    return Reflect.apply(original, client, args);
  });
  await expect(retainUntilConverged(database)).rejects.toMatchObject({ errors: [primary, unlock] });
  expect(client.release).toHaveBeenCalledWith(true);
});

it.each([false, true])("preserves a retention failure when client release also fails (converged=%s)", async converged => {
  const { database, client, change } = retentionFixture();
  const primary = new Error("Synthetic retention failure.");
  const release = new Error("Synthetic release failure.");
  change.mockRejectedValue(primary);
  client.release.mockImplementation(() => { throw release; });
  const pending = converged ? retainUntilConverged(database) : retain(database);
  await expect(pending).rejects.toMatchObject({ errors: [primary, release] });
  expect(client.release).toHaveBeenCalledOnce();
});

it.each(["committed", "dry-run", "failed", "release-failed", "later-failed", "rolled-back", "metric-failed", "unlock-failed"] as const)(
  "reports operator retention metrics only for a committed slice: %s", async outcome => {
    const database = new pg.Pool({ max: 4 });
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    vi.spyOn(database, "connect").mockImplementation(async () => client);
    vi.spyOn(database, "query").mockRejectedValue(new Error("Unexpected pool query."));
    vi.spyOn(LifecycleSlice.prototype, "change").mockResolvedValue(0);
    const result = (rows: object[] = []) => ({ command: "", oid: 0, fields: [], rowCount: rows.length, rows });
    const primary = new Error("Synthetic operator commit failure.");
    if (outcome === "release-failed") client.release.mockImplementation(() => { throw primary; });
    if (outcome === "metric-failed") {
      const scope = metrics.dataWorkMetricScope();
      vi.spyOn(metrics, "dataWorkMetricScope").mockReturnValue({
        ...scope, commit: () => { scope.commit(); throw primary; },
      });
    }
    let commits = 0;
    const query = vi.spyOn(client, "query").mockImplementation(async statement => {
      if (typeof statement !== "string") throw new Error("Unexpected query shape.");
      if (statement === "COMMIT") {
        commits++;
        if (outcome === "rolled-back") return { ...result(), command: "ROLLBACK" };
        if (outcome === "failed" || outcome === "later-failed" && commits === 2) throw primary;
        return { ...result(), command: "COMMIT" };
      }
      if (statement.includes("pg_try_advisory_xact_lock")) return result([{ acquired: true }]);
      if (statement.includes("pg_try_advisory_lock_shared")) return result([{ acquired: true }]);
      if (statement.includes("pg_advisory_unlock_shared")) return result([{ unlocked: outcome !== "unlock-failed" }]);
      if (statement.startsWith("SELECT cursor->>'step'")) return result([{ step: "0" }]);
      if (statement.startsWith("SELECT count(*)::text AS roots")) return result([{ roots: "7", age: "60000" }]);
      if (statement.startsWith("SELECT to_regclass")) return result([{ name: null }]);
      if (statement.startsWith("SELECT cursor FROM")) return result([{ cursor: {} }]);
      if (statement.startsWith("SELECT id,kind,status") || statement.startsWith("SELECT tenant_id FROM")) return result();
      if (["BEGIN", "ROLLBACK"].includes(statement) || statement.startsWith("SET LOCAL")
        || statement.startsWith("UPDATE data_lifecycle_progress")) return result();
      throw new Error("Unexpected operator query.");
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const pending = outcome === "later-failed" || outcome === "unlock-failed"
      ? retainUntilConverged(database, { maximumPasses: 2 }) : retain(database, { dryRun: outcome === "dry-run" });
    if (outcome === "unlock-failed") await expect(pending).rejects.toThrow("Retention schema lock ownership was lost.");
    else if (outcome === "rolled-back") await expect(pending).rejects.toThrow("data_transaction_not_committed");
    else if (["failed", "release-failed", "later-failed", "metric-failed"].includes(outcome)) await expect(pending).rejects.toBe(primary);
    else await expect(pending).resolves.toMatchObject({ dryRun: outcome === "dry-run" });
    const snapshot = metrics.flushDataWorkMetrics();
    if (["committed", "release-failed", "later-failed", "metric-failed", "unlock-failed"].includes(outcome)) expect(snapshot).toEqual([expect.objectContaining({
      stage: "record_gc", count: outcome === "unlock-failed" ? 4 : 2, backlogRoots: 7, oldestAgeMs: 60000, rows: 121, bytes: 524800,
    })]);
    else expect(snapshot).toEqual([]);
    expect(query).toHaveBeenCalledWith(["committed", "release-failed", "metric-failed", "unlock-failed"].includes(outcome) ? "COMMIT" : "ROLLBACK");
    if (["committed", "release-failed", "metric-failed", "unlock-failed"].includes(outcome)) expect(query).not.toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  },
);
