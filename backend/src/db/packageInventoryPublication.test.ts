import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allowlistedPackage } from "../services/packageObservation.js";
import { PackageInventoryRepository } from "./packageInventory.js";
import { pool } from "./pool.js";

const scope = { tenantId: "publication-tenant", principalId: "publication-reader" };
const job = {
  id: "11111111-1111-4111-8111-111111111111",
  authorization_principal_id: scope.principalId,
  token_mode: "delegated",
  query_hash: "query-hash",
  scope_kind: "broad",
  requested_ids: [],
  status: "running",
  page_count: 1,
  observed_count: 1,
  total_records: 1,
  error_code: null,
  message: null,
  created_at: new Date("2026-09-23T00:00:00.000Z"),
  attempted_at: new Date("2026-09-23T00:00:00.000Z"),
  updated_at: new Date("2026-09-23T00:00:00.000Z"),
  finished_at: null,
  deadline_at: new Date("2026-09-23T04:00:00.000Z"),
  snapshot_id: null,
};
const result = {
  packages: [allowlistedPackage({ id: "package", displayName: "Package", isBlocked: false })],
  totalRecords: 1,
  pages: 1,
};
const emptyResult = { command: "SELECT", rowCount: 0, oid: 0, fields: [], rows: [] };

function fixture() {
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  const query = vi.spyOn(client, "query").mockRejectedValue(new Error("Unexpected publication transaction query."));
  vi.spyOn(pool, "connect").mockResolvedValue(client);
  const read = vi.spyOn(pool, "query").mockRejectedValue(new Error("Unexpected publication read query."));
  query.mockResolvedValueOnce(emptyResult)
    .mockResolvedValueOnce(emptyResult)
    .mockResolvedValueOnce({ ...emptyResult, rowCount: 1, rows: [job] })
    .mockResolvedValueOnce(emptyResult)
    .mockResolvedValueOnce(emptyResult)
    .mockResolvedValueOnce(emptyResult)
    .mockResolvedValueOnce(emptyResult)
    .mockResolvedValueOnce(emptyResult);
  return { client, query, read, repository: new PackageInventoryRepository() };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("package publication deadline fence", () => {
  it("checks the running state and both time limits after snapshot writes, before committing", async () => {
    const { client, query, read, repository } = fixture();
    query.mockResolvedValueOnce({ ...emptyResult, rowCount: 1, rows: [{ id: job.id }] })
      .mockResolvedValueOnce(emptyResult);
    read.mockResolvedValueOnce({ ...emptyResult, rowCount: 1, rows: [{ ...job, status: "succeeded" }] });

    await expect(repository.publish(scope, job.id, result)).resolves.toMatchObject({ job: { status: "succeeded" } });

    const completion = query.mock.calls[8];
    expect(completion[0]).toContain("SET status='succeeded'");
    expect(completion[0]).toContain("status='running'");
    expect(completion[0]).toContain("deadline_at>clock_timestamp()");
    expect(completion[0]).toContain("expires_at>clock_timestamp()");
    expect(completion[1]).toEqual([job.id, scope.tenantId, scope.principalId, 1, 1, 1]);
    expect(query.mock.calls[9][0]).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rolls back snapshot replacement when the final deadline fence no longer matches", async () => {
    const { client, query, read, repository } = fixture();
    query.mockResolvedValueOnce(emptyResult).mockResolvedValueOnce(emptyResult);

    await expect(repository.publish(scope, job.id, result)).rejects.toMatchObject({ code: "package_refresh_expired" });

    expect(query.mock.calls[4][0]).toContain("SET is_current=false");
    expect(query.mock.calls[5][0]).toContain("INSERT INTO package_inventory_snapshots");
    expect(query.mock.calls[9][0]).toBe("ROLLBACK");
    expect(query.mock.calls.some(([statement]) => statement === "COMMIT")).toBe(false);
    expect(read).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("propagates a final write failure and rolls back instead of returning a snapshot", async () => {
    const { client, query, read, repository } = fixture();
    const failure = new Error("Publication write failed.");
    query.mockRejectedValueOnce(failure).mockResolvedValueOnce(emptyResult);

    await expect(repository.publish(scope, job.id, result)).rejects.toBe(failure);

    expect(query.mock.calls[9][0]).toBe("ROLLBACK");
    expect(read).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledOnce();
  });
});
