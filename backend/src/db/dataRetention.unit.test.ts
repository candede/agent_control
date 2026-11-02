import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reportExportAudit } from "../services/reportExportAudit.js";
import { retainDeletedReportRows, retainRecordData } from "./dataRetention.js";
import { LifecycleSlice, lifecycleLimits } from "./lifecycleSlice.js";

vi.mock("../services/reportExportAudit.js", () => ({ reportExportAudit: vi.fn(async () => undefined) }));
vi.mock("../services/dataMetrics.js", () => ({ observeDataWork: vi.fn() }));
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

type ExportRow = {
  id: string; kind: "official_users"; status: "queued" | "building" | "ready";
  row_count: number; byte_count: string; actor: object | null; bytes: number;
};
const exportRow = (status: ExportRow["status"] = "queued"): ExportRow => ({
  id: "10000000-0000-4000-8000-000000000001", kind: "official_users", status,
  row_count: 5, byte_count: "200",
  actor: { tenantId: "synthetic-tenant", homeAccountId: "synthetic-principal",
    username: "user@example.invalid", displayName: "Synthetic User" },
  bytes: 1024,
});

function fixture(exports: ExportRow[] = [], resume = "0", acquired = true) {
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  const result = (rows: pg.QueryResultRow[] = []): pg.QueryResult =>
    ({ command: "SELECT", oid: 0, fields: [], rowCount: rows.length, rows });
  const query = vi.spyOn(client, "query").mockImplementation(async statement => {
    if (typeof statement !== "string") throw new Error("Unexpected retention query shape");
    if (statement.includes("pg_try_advisory_xact_lock")) return result([{ acquired }]);
    if (statement.startsWith("SELECT cursor->>'step'")) return result([{ step: resume }]);
    if (statement.startsWith("SELECT count(*)::text AS roots")) return result([{ roots: "0", age: "0" }]);
    if (statement.startsWith("SELECT id,kind,status")) return result(exports);
    if (statement.startsWith("SELECT current_setting(")) return result([{ rows: "0", bytes: "0" }]);
    if (statement.startsWith("WITH ")) return result([{
      rows: 0, bytes: 0, reserved_bytes: 0, charged_rows: 0, base_rows: 0, full: false,
    }]);
    if (statement.startsWith("SET LOCAL") || statement.startsWith("SELECT set_config(")
      || statement.startsWith("UPDATE data_exports") || statement.startsWith("UPDATE data_lifecycle_progress")) return result();
    throw new Error(`Unexpected retention query: ${statement}`);
  });
  const change = vi.spyOn(LifecycleSlice.prototype, "change");
  return { client, query, change };
}

describe("record retention shared lifecycle bounds", () => {
  it.each(["rows", "bytes"] as const)("defers export expiration when the shared %s budget cannot cover it", async bound => {
    const { client, query } = fixture([exportRow()]);
    const slice = new LifecycleSlice(client, 250);
    slice[bound] = lifecycleLimits[bound] - 1;
    const before = { rows: slice.rows, bytes: slice.bytes };
    const affected = await retainRecordData(client, 250, slice);
    expect(affected.recordExpiredExports).toBe(0);
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith("UPDATE data_exports"))).toBe(false);
    expect(reportExportAudit).not.toHaveBeenCalled();
    expect({ rows: slice.rows, bytes: slice.bytes }).toEqual(before);
    await slice.finish();
    expect(query).toHaveBeenCalledWith(expect.stringContaining("UPDATE data_lifecycle_progress"),
      [2, before.rows, before.bytes, "records"]);
  });

  it("does not repeat export expiration while resuming a later relation", async () => {
    const { client, query } = fixture([exportRow()], "3");
    expect((await retainRecordData(client)).recordExpiredExports).toBe(0);
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith("UPDATE data_exports"))).toBe(false);
    expect(reportExportAudit).not.toHaveBeenCalled();
  });

  it.each(["queued", "building", "ready"] as const)("charges the actual write count and preserves %s export auditing", async status => {
    const row = exportRow(status), { client, query } = fixture([row]);
    const slice = new LifecycleSlice(client, 250);
    expect((await retainRecordData(client, 250, slice)).recordExpiredExports).toBe(1);
    expect(query).toHaveBeenCalledWith("UPDATE data_exports SET status='expired',error_code='export_expired' WHERE id=$1", [row.id]);
    expect(slice.rows).toBe(status === "ready" ? 2 : 3);
    expect(slice.bytes).toBe(512 + row.bytes + 16_384);
    if (status === "ready") expect(reportExportAudit).not.toHaveBeenCalled();
    else expect(reportExportAudit).toHaveBeenCalledExactlyOnceWith(client, {
      id: row.id, exportId: row.id, kind: row.kind, phase: "build", status: "failed",
      rows: 5, bytes: 200, errorCode: "export_expired",
    });
  });

  it("does not charge an audit write for an export without a stored actor", async () => {
    const row = { ...exportRow(), actor: null }, { client } = fixture([row]);
    const slice = new LifecycleSlice(client, 250);
    expect((await retainRecordData(client, 250, slice)).recordExpiredExports).toBe(1);
    expect(slice.rows).toBe(2);
    expect(reportExportAudit).not.toHaveBeenCalled();
  });

  it("expires a ready export at exact row-budget equality", async () => {
    const { client } = fixture([exportRow("ready")]);
    const slice = new LifecycleSlice(client, 250);
    slice.rows = lifecycleLimits.rows - 1;
    expect((await retainRecordData(client, 250, slice)).recordExpiredExports).toBe(1);
    expect(slice.rows).toBe(lifecycleLimits.rows);
    expect(reportExportAudit).not.toHaveBeenCalled();
  });

  it("propagates an expiration audit failure without collecting export payloads or persisting progress", async () => {
    const { client, query } = fixture([exportRow()]);
    const failure = new Error("Synthetic expiration audit failure");
    vi.mocked(reportExportAudit).mockRejectedValueOnce(failure);
    await expect(retainRecordData(client)).rejects.toBe(failure);
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith("UPDATE data_lifecycle_progress"))).toBe(false);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("DELETE FROM data_export_chunks"))).toBe(false);
  });

  it("leaves an unavailable retention lock and invalid batch sizes untouched", async () => {
    const { client, query } = fixture([], "0", false);
    await expect(retainRecordData(client)).resolves.toEqual({});
    expect(query).toHaveBeenCalledOnce();
    query.mockClear();
    for (const limit of [0, 251, 1.5]) await expect(retainRecordData(client, limit)).rejects.toThrow("data_retention_batch");
    expect(query).not.toHaveBeenCalled();
  });
});

describe("Office retention range and physical ownership", () => {
  it("limits timeline expiration invalidation to published head captures, excluding superseded weekly evidence", async () => {
    const { client, change } = fixture();
    await retainRecordData(client);
    const invalidation = change.mock.calls.find(([name]) => name === "officeInvalidSelections")?.[2];
    expect(invalidation).toContain("expired_generation.state='published'");
    expect(invalidation).toContain("data_generation_heads");
    expect(invalidation).toContain("head.generation_id=expired_generation.id");
    expect(invalidation).toContain("expired_generation.expires_at>target.evaluated_at");
    expect(invalidation).toContain("expired_generation.observed_at<=target.evaluated_at");
    const deletion = change.mock.calls.find(([name]) => name === "recordDeletingGenerations")?.[2];
    expect(deletion).toContain("head.generation_id=target.id");
    expect(deletion).toContain("selection.invalidated_at IS NULL");
  });

  it("preserves Office staging source leases and collects children before headers and quota release", async () => {
    const { client, change } = fixture();
    await retainRecordData(client);
    const calls = change.mock.calls, names = calls.map(([name]) => name);
    expect(calls.find(([name]) => name === "recordDeletingGenerations")?.[2])
      .toContain("target.id IN (office.directory_generation_id,office.app_generation_id)");
    expect(calls.find(([name]) => name === "recordDeletingGenerations")?.[2])
      .toContain("staging.state IN ('staging','validating') AND staging.lease_until>clock_timestamp()");
    expect(names.indexOf("officePeople")).toBeLessThan(names.indexOf("officeObservations"));
    expect(names.indexOf("officeGroups")).toBeLessThan(names.indexOf("officeObservations"));
    expect(names.indexOf("officeObservations")).toBeLessThan(names.indexOf("recordCollectedGenerations"));
    for (const name of ["officeObservations", "recordCollectedGenerations"]) {
      const where = calls.find(([operation]) => operation === name)?.[2];
      expect(where).toContain("NOT EXISTS(SELECT 1 FROM office_person_facts");
      expect(where).toContain("NOT EXISTS(SELECT 1 FROM office_group_facts");
    }
    expect(calls.find(([name]) => name === "recordCollectedGenerations")?.[6]).toBe("collection");
  });

  it("keeps report-row retention protected by the pinned history membership interval in both entry points", async () => {
    const { client, query, change } = fixture();
    await retainDeletedReportRows(client, 25, { tenantId: "synthetic-tenant", setId: "10000000-0000-4000-8000-000000000002" });
    const scoped = String(query.mock.calls[0][0]);
    expect(query.mock.calls[0][1]).toEqual(["synthetic-tenant", "10000000-0000-4000-8000-000000000002", 25]);
    await retainRecordData(client);
    const global = change.mock.calls.find(([name]) => name === "recordDeletedReportRows")?.[2];
    for (const sql of [scoped, global]) {
      expect(sql).toContain("p.root_kind='tenant_history'");
      expect(sql).toContain("p.expires_at>clock_timestamp()");
      expect(sql).toContain("p.revision::bigint>=h.valid_from_revision");
      expect(sql).toContain("p.revision::bigint<h.valid_to_revision");
    }
  });
});
