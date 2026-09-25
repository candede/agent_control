import { beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "../db/pool.js";
import { AuditLog } from "./auditLog.js";

vi.mock("../db/pool.js", () => ({ pool: { query: vi.fn() }, secretValue: vi.fn() }));

const scope = { tenantId: "tenant-audit", principalId: "principal-audit" };
const query = vi.mocked(pool.query);
const emptyResult = { command: "SELECT", rowCount: 0, oid: 0, fields: [], rows: [] };
const row = {
  event_id: "attempt:1", operation_id: "job-1", tenant_id: scope.tenantId, principal_id: scope.principalId,
  actor_username: "fixture@example.invalid", actor_name: "Fixture", scope: "bulk", action: "block",
  target_blocked_state: true, agent_id: "package-1", agent_display_name: "Package",
  started_at: new Date("2026-09-24T00:00:00.000Z"), completed_at: null, status: "started",
  message: null, error_code: null, request_path: "/api/agents/block",
  metadata: { leaseVersion: 1, correlationId: "correlation-1", prestateHash: "before", verification: "pending_dispatch" },
};

beforeEach(() => {
  query.mockReset().mockRejectedValue(new Error("Unexpected audit database query."));
});

describe("audit outcome evidence", () => {
  it("preserves start provenance when appending outcome and reconciliation metadata", async () => {
    const audit = new AuditLog(scope);
    const outcome = { poststateHash: "after", readbackCount: 1, reconciliationStatus: "required", verification: "not_verified" };
    query.mockResolvedValueOnce({ ...emptyResult, rows: [row] }).mockResolvedValueOnce(emptyResult);
    const completed = await audit.completeEvent(row.event_id, { status: "inconclusive", metadata: outcome });
    expect(completed.metadata).toEqual({ ...row.metadata, ...outcome });
    expect(query.mock.calls[1][1]?.[18]).toEqual(completed.metadata);
    expect(row.metadata).not.toHaveProperty("poststateHash");

    query.mockResolvedValueOnce({ ...emptyResult, rows: [{
      ...row, status: completed.status, completed_at: new Date(completed.completedAt!), metadata: completed.metadata,
    }] }).mockResolvedValueOnce(emptyResult);
    const reconciled = await audit.completeEvent(row.event_id, {
      status: "succeeded", metadata: { reconciliationStatus: "verified_applied", verification: "provider_reconciliation" },
    });
    expect(reconciled.metadata).toEqual({
      ...row.metadata, ...outcome, reconciliationStatus: "verified_applied", verification: "provider_reconciliation",
    });
  });

  it("filters updates before merging so invalid fields cannot erase valid provenance", async () => {
    query.mockResolvedValueOnce({ ...emptyResult, rows: [row] }).mockResolvedValueOnce(emptyResult);
    const completed = await new AuditLog(scope).completeEvent(row.event_id, {
      status: "failed", metadata: { correlationId: "x".repeat(129), prestateHash: {}, accessToken: "discard", rows: ["discard"] },
    });
    expect(completed.metadata).toEqual(row.metadata);
    expect(query.mock.calls[1][1]?.[18]).toEqual(row.metadata);
  });

  it("keeps the original metadata when no new evidence is supplied", async () => {
    query.mockResolvedValueOnce({ ...emptyResult, rows: [row] }).mockResolvedValueOnce(emptyResult);
    expect((await new AuditLog(scope).completeEvent(row.event_id, { status: "cancelled" })).metadata).toEqual(row.metadata);
  });
});

describe("audit read contracts", () => {
  it.each(["event", "list", "count", "export", "operation"] as const)(
    "applies principal scope and 90-day expiry to %s reads before selection", async method => {
      query.mockResolvedValueOnce({ ...emptyResult, rows: method === "count" ? [{ count: 0 }] : [] });
      const audit = new AuditLog(scope);
      if (method === "event") await audit.getEvent("event-1");
      else if (method === "list") await audit.listEvents({ limit: 10, offset: 20 });
      else if (method === "count") await audit.countEvents();
      else if (method === "export") await audit.getExportEvents(["event-1"]);
      else await audit.matchingOperationPackageIds(["package-1"], "REF_CASE");
      expect(query).toHaveBeenCalledOnce();
      const [statement, values] = query.mock.calls[0];
      expect(statement).toContain("tenant_id=$1 AND principal_id=$2");
      expect(statement).toContain("observed_at>clock_timestamp()-interval '90 days'");
      expect(values?.slice(0, 2)).toEqual([scope.tenantId, scope.principalId]);
    },
  );

  it("matches operation prefixes case-insensitively and escapes literal underscores in both list and count", async () => {
    query.mockResolvedValueOnce(emptyResult).mockResolvedValueOnce({ ...emptyResult, rows: [{ count: 0 }] });
    const audit = new AuditLog(scope);
    await audit.listEvents({ operationIdPrefix: "REF_CASE" });
    await audit.countEvents({ operationIdPrefix: "REF_CASE" });
    for (const [statement, values] of query.mock.calls) {
      expect(statement).toContain("operation_id ILIKE $3 ESCAPE '\\'");
      expect(values?.[2]).toBe("REF\\_CASE%");
    }
  });

  it("rejects an offset beyond the read budget instead of returning a different page", async () => {
    await expect(new AuditLog(scope).listEvents({ offset: 100_001 }))
      .rejects.toMatchObject({ code: "invalid_audit_offset" });
    expect(query).not.toHaveBeenCalled();
  });
});
