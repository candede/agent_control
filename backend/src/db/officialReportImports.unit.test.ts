import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OfficialReportImports } from "./officialReportImports.js";
import type { SelectionIdentity } from "../services/dataSelections.js";

const identity: SelectionIdentity = { tenantId: "tenant-import", principalId: "operator-import",
  sessionEpoch: "1", authorizationHash: "admin" };
const bundleId = "60000000-0000-4000-8000-000000000001";
const pools = new Set<pg.Pool>();
afterEach(async () => {
  for (const database of pools) await database.end();
  pools.clear();
  vi.restoreAllMocks();
});

function fixture() {
  const database = new pg.Pool({ max: 4 });
  pools.add(database);
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  const stages = (["agents", "userAgents", "users"] as const).map((kind, index) => ({
    id: `70000000-0000-4000-8000-00000000000${index + 1}`, kind, revision: 1, content_hash: String(index + 1).repeat(64),
    row_count: 1, reconciliation: { rows: 1, responses: 2, agentsUsed: null },
    period_provenance: "activity_range", reporting_start: null, reporting_end: null,
    source_as_of_provenance: "operator_asserted", source_as_of: new Date(`2026-02-0${index + 1}T00:00:00Z`),
  }));
  const result = (rows: object[]) => ({ command: "", oid: 0, fields: [], rowCount: rows.length, rows });
  const query = vi.fn(async (text: unknown, values?: unknown) => {
    if (typeof text !== "string") throw new Error("Expected SQL.");
    if (["BEGIN ISOLATION LEVEL REPEATABLE READ", "COMMIT", "ROLLBACK"].includes(text)) return result([]);
    if (text.startsWith("INSERT INTO data_principal_epochs")) return result([]);
    if (text.startsWith("SELECT epoch FROM data_principal_epochs")) return result([{ epoch: "1" }]);
    if (text.startsWith("SELECT revision::text FROM official_usage_state")) return result([{ revision: "4" }]);
    if (text.includes("FROM official_usage_bundle_receipts")) return result([]);
    if (text.includes("FROM official_usage_staging s JOIN official_usage_ingestions")) {
      expect(values).toEqual([identity.tenantId, identity.principalId, bundleId, identity.sessionEpoch]);
      expect(text).toContain("i.session_epoch=$4 AND s.expires_at>clock_timestamp()");
      expect(text).toContain("LIMIT 4");
      return result(stages);
    }
    throw new Error("Unexpected import query.");
  });
  vi.spyOn(client, "query").mockImplementation(query);
  vi.spyOn(database, "connect").mockImplementation(vi.fn(async () => client));
  vi.spyOn(database, "query").mockRejectedValue(new Error("Unexpected unscoped database query."));
  return { imports: new OfficialReportImports(database), stages, query };
}

describe("bundle validation and cleanup inspection without a database", () => {
  it("preserves normal validation of incompatible observation metadata", async () => {
    const { imports } = fixture();
    await expect(imports.bundle(identity, bundleId)).rejects.toMatchObject({ code: "incompatible_bundle" });
    await expect(imports.bundle(identity, bundleId, { forDiscard: false })).rejects.toMatchObject({ code: "incompatible_bundle" });
  });

  it("lists bounded owned companions for cleanup despite incompatible metadata", async () => {
    const { imports, stages, query } = fixture();
    const preview = await imports.bundle(identity, bundleId, { forDiscard: true });
    expect(preview).toMatchObject({ bundleId, complete: true, expectedActiveRevision: "4" });
    expect(preview.stages.map(stage => stage.stagingId)).toEqual(stages.map(stage => stage.id));
    expect(query.mock.calls.some(([text]) => typeof text === "string" && /^(UPDATE|DELETE)/.test(text))).toBe(false);
  });

  it("cannot use a cleanup inspection to bypass acceptance validation", async () => {
    const { imports } = fixture();
    const preview = await imports.bundle(identity, bundleId, { forDiscard: true });
    await expect(imports.acceptBundle(identity, bundleId, preview)).rejects.toMatchObject({ code: "incompatible_bundle" });
  });

  it("still rejects a retired session before revealing cleanup receipts", async () => {
    const { imports, query } = fixture();
    await expect(imports.bundle({ ...identity, sessionEpoch: "2" }, bundleId, { forDiscard: true }))
      .rejects.toMatchObject({ code: "staging_unavailable" });
    expect(query.mock.calls.some(([text]) => typeof text === "string" && text.includes("FROM official_usage_staging"))).toBe(false);
  });
});

describe("atomic staged-import discard without a database", () => {
  function discarded(initial: "ready" | "accepting" | "accepted" = "ready") {
    const { imports, query } = fixture();
    const stagingId = "70000000-0000-4000-8000-000000000001", ingestionId = "80000000-0000-4000-8000-000000000001";
    let state: string = initial, status = initial === "accepted" ? "accepted" : "active", inspected = false;
    const commits: Array<{ state: string; status: string }> = [];
    const result = (rows: object[]) => ({ command: "", oid: 0, fields: [], rowCount: rows.length, rows });
    query.mockImplementation(async (text, values) => {
      if (typeof text !== "string") throw new Error("Expected SQL.");
      if (text === "BEGIN" || text === "ROLLBACK") return result([]);
      if (text === "COMMIT") {
        commits.push({ state, status });
        // A competing acceptance can acquire these rows as soon as discard releases them.
        if (inspected && state === "ready") state = "accepting";
        return result([]);
      }
      if (text.startsWith("INSERT INTO data_principal_epochs")) return result([]);
      if (text.startsWith("SELECT epoch FROM data_principal_epochs")) return result([{ epoch: "1" }]);
      if (text.startsWith("SELECT i.id,s.kind,s.row_count")) {
        expect(values).toEqual([stagingId, identity.tenantId, identity.principalId, identity.sessionEpoch]);
        expect(text).toContain("s.status='active' AND i.state='ready' AND i.session_epoch=$4 FOR UPDATE OF s,i");
        inspected = true;
        return result(state === "ready" && status === "active" ? [{ id: ingestionId, kind: "agents", row_count: 1 }] : []);
      }
      if (text.startsWith("UPDATE official_usage_ingestions SET state='cancelled'")) {
        state = "cancelled";
        return result([{ staging_id: stagingId, kind: "agents", row_count: 1 }]);
      }
      if (text.startsWith("UPDATE official_usage_staging SET status='cancelled'")) { status = "cancelled"; return result([]); }
      if (text.startsWith("INSERT INTO official_usage_audit")) return result([]);
      throw new Error("Unexpected discard query.");
    });
    const cleanup = vi.spyOn(imports, "cleanupIngestion").mockResolvedValue(0);
    return { imports, query, cleanup, commits, stagingId, ingestionId };
  }

  it("cancels under the same ready-state row locks, before a competing acceptance can start", async () => {
    const { imports, query, cleanup, commits, stagingId, ingestionId } = discarded();
    await imports.discard(identity, stagingId);
    expect(commits).toEqual([{ state: "cancelled", status: "cancelled" }]);
    expect(cleanup).toHaveBeenCalledExactlyOnceWith(ingestionId);
    expect(query.mock.calls.filter(([text]) => typeof text === "string" && text.startsWith("INSERT INTO official_usage_audit"))).toHaveLength(1);
  });

  it.each(["accepting", "accepted"] as const)("cannot cancel an already %s import", async state => {
    const { imports, query, cleanup, stagingId } = discarded(state);
    await expect(imports.discard(identity, stagingId)).rejects.toMatchObject({ code: "staging_unavailable" });
    expect(query.mock.calls.some(([text]) => typeof text === "string" && text.startsWith("UPDATE"))).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("retains durable cancellation when post-commit cleanup fails", async () => {
    const { imports, cleanup, commits, stagingId } = discarded();
    cleanup.mockRejectedValueOnce(new Error("Cleanup unavailable"));
    await expect(imports.discard(identity, stagingId)).rejects.toThrow("Cleanup unavailable");
    expect(commits).toEqual([{ state: "cancelled", status: "cancelled" }]);
    await expect(imports.discard(identity, stagingId)).rejects.toMatchObject({ code: "staging_unavailable" });
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
