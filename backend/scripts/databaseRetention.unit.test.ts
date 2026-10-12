import pg from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { retain, retainUntilConverged } from "./database.js";
import { LifecycleSlice } from "../src/db/lifecycleSlice.js";
import * as metrics from "../src/services/dataMetrics.js";

vi.mock("../src/db/schema.js", async original => ({
  ...await original<typeof import("../src/db/schema.js")>(), verifySchema: vi.fn(async () => undefined),
}));

afterEach(() => { metrics.flushDataWorkMetrics(); vi.restoreAllMocks(); });

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
