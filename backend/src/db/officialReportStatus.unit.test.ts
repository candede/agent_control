import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OfficialReportStatusRepository, directoryNeedsReportRefresh } from "./officialReportStatus.js";
import { readableReportVersionSql } from "./reportCapacitySchema.js";

const databases: pg.Pool[] = [];
const scope = { tenantId: "synthetic-report-status", principalId: "synthetic-viewer" };
const acceptedAt = new Date("2026-10-10T10:00:00.000Z");

afterEach(async () => {
  await Promise.all(databases.splice(0).map(database => database.end()));
  vi.restoreAllMocks();
});

function fixture(rows: pg.QueryResultRow[] = [], failure?: Error) {
  const database = new pg.Pool({ max: 4 });
  databases.push(database);
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  vi.spyOn(database, "connect").mockImplementation(async () => client);
  vi.spyOn(database, "query").mockRejectedValue(new Error("Unit tests must not access a database."));
  const query = vi.spyOn(client, "query").mockImplementation(async text => {
    if (typeof text !== "string") throw new Error("Unexpected query shape.");
    if (["BEGIN ISOLATION LEVEL REPEATABLE READ", "COMMIT", "ROLLBACK"].includes(text)) {
      return { command: text, rows: [], rowCount: 0, oid: 0, fields: [] };
    }
    if (!text.startsWith("SELECT s.accepted_at") && !text.startsWith("SELECT 1 FROM official_usage_state report")) {
      throw new Error("Unexpected status query.");
    }
    if (failure) throw failure;
    return { command: "SELECT", rows, rowCount: rows.length, oid: 0, fields: [] };
  });
  return { database, client, query, repository: new OfficialReportStatusRepository(database) };
}

describe("official report availability", () => {
  it("reports no accepted bundle on a clean first run", async () => {
    const f = fixture();
    await expect(f.repository.read(scope.tenantId)).resolves.toEqual({ complete: false, count: 0, acceptedAt: null });
    expect(f.query).toHaveBeenCalledWith("COMMIT");
    expect(f.client.release).toHaveBeenCalledOnce();
  });

  it.each([0, 17, 3_000_000])("returns the exact accepted total, including %i rows", async count => {
    const f = fixture([{ kinds: 3, rows: String(count), accepted_at: acceptedAt }]);
    await expect(f.repository.read(scope.tenantId)).resolves.toEqual({
      complete: true, count, acceptedAt: acceptedAt.toISOString(),
    });
  });

  it.each([1, 2])("does not report a bundle with only %i readable kinds as complete", async kinds => {
    const f = fixture([{ kinds, rows: "17", accepted_at: acceptedAt }]);
    await expect(f.repository.read(scope.tenantId)).resolves.toMatchObject({ complete: false, count: 0 });
  });

  it("counts only live versions whose stored membership matches the declared row count", async () => {
    const f = fixture();
    await f.repository.read(scope.tenantId);
    expect(f.query).toHaveBeenCalledWith(expect.stringContaining(
      readableReportVersionSql("v.id", "v.tenant_id", "v.kind", "v.row_count"),
    ), [scope.tenantId]);
    const sql = f.query.mock.calls.find(([text]) => typeof text === "string" && text.startsWith("SELECT s.accepted_at"))?.[0];
    expect(sql).toContain("s.complete AND s.deleted_at IS NULL AND v.deleted_at IS NULL");
    for (const alias of ["s", "v", "a"]) {
      expect(sql).toContain(`(${alias}.expires_at IS NULL OR ${alias}.expires_at>clock_timestamp())`);
    }
  });

  it("propagates read failures and releases the rolled-back connection", async () => {
    const failure = new Error("Synthetic report status failure."), f = fixture([], failure);
    await expect(f.repository.read(scope.tenantId)).rejects.toBe(failure);
    expect(f.query).toHaveBeenCalledWith("ROLLBACK");
    expect(f.query).not.toHaveBeenCalledWith("COMMIT");
    expect(f.client.release).toHaveBeenCalledOnce();
  });
});

describe("directory refresh after report selection", () => {
  it.each([false, true])("returns the selected-report freshness decision: %s", async refresh => {
    const f = fixture(refresh ? [{}] : []);
    await expect(directoryNeedsReportRefresh(f.client, scope)).resolves.toBe(refresh);
    expect(f.query).toHaveBeenCalledWith(expect.any(String), [scope.tenantId]);
  });

  it("requires three readable, undeleted and unexpired versions rather than only a complete set", async () => {
    const f = fixture();
    await directoryNeedsReportRefresh(f.client, scope);
    const sql = f.query.mock.calls[0][0];
    expect(sql).toContain("3=(SELECT count(*) FROM official_usage_set_versions sv");
    expect(sql).toContain("sv.set_id=current.id AND sv.tenant_id=current.tenant_id");
    expect(sql).toContain("v.deleted_at IS NULL");
    expect(sql).toContain(readableReportVersionSql("v.id", "v.tenant_id", "v.kind", "v.row_count"));
    for (const alias of ["current", "v", "a"]) {
      expect(sql).toContain(`(${alias}.expires_at IS NULL OR ${alias}.expires_at>clock_timestamp())`);
    }
  });

  it("acknowledges selection changes only through a current tenant directory collection started afterward", async () => {
    const f = fixture();
    await directoryNeedsReportRefresh(f.client, scope);
    const sql = f.query.mock.calls[0][0];
    expect(sql).toContain("generation.state='published'");
    expect(sql).toContain("generation.scope_epoch=scope.epoch AND generation.session_epoch=scope.session_epoch");
    expect(sql).toContain("scope.tenant_id=$1 AND scope.scope_kind='tenant' AND scope.token_mode='tenant'");
    expect(sql).toContain("scope.source='directory' AND scope.selector='complete' AND generation.created_at>=report.updated_at");
    expect(sql).not.toContain("scope.principal_id");
  });

  it("propagates freshness query failures rather than treating the directory as current", async () => {
    const failure = new Error("Synthetic report freshness failure."), f = fixture([], failure);
    await expect(directoryNeedsReportRefresh(f.client, scope)).rejects.toBe(failure);
  });
});
