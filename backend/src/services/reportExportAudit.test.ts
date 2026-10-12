import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { reportExportAudit } from "./reportExportAudit.js";
import type { ExportAudit, ExportKind } from "./dataExports.js";

vi.mock("../db/pool.js", () => ({ pool: {}, secretValue: vi.fn() }));

const id = "11111111-1111-4111-8111-111111111111";
const selection = "22222222-2222-4222-8222-222222222222";
const setId = "33333333-3333-4333-8333-333333333333";
const actor = { tenantId: "tenant", homeAccountId: "principal", username: "fixture@example.invalid", displayName: "Fixture" };
const start: Parameters<ExportAudit>[1] = {
  id, exportId: id, kind: "official_users", phase: "build", status: "started", rows: 0, bytes: 0,
};

function fixture(kind: ExportKind = "official_users") {
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  const job = { tenant_id: actor.tenantId, principal_id: actor.homeAccountId, actor: { ...actor, roles: ["private-role"] },
    kind, selection_id: selection, query_hash: "a".repeat(64), selection_mode: "explicit", set_id: setId, history_revision: "17" };
  const receipts: pg.QueryResultRow[] = [];
  const result = (rows: object[] = []) => ({ command: "SELECT", fields: [], oid: 0, rowCount: rows.length, rows });
  const query = vi.spyOn(client, "query").mockImplementation(async (statement: unknown, values?: unknown[]) => {
    if (typeof statement !== "string") throw new Error("Unexpected audit query shape.");
    if (statement.startsWith("SELECT e.tenant_id,e.principal_id,e.actor")) return result([job]);
    if (statement.startsWith("SELECT * FROM audit_projection")) {
      expect(values).toEqual([actor.tenantId, actor.homeAccountId, receipts.at(-1)?.event_id]);
      return result(receipts.slice(-1));
    }
    if (statement.startsWith("INSERT INTO audit_events")) {
      receipts.push({
        event_id: values?.[1], operation_id: values?.[2], tenant_id: values?.[3], principal_id: values?.[4],
        actor_username: values?.[5], actor_name: values?.[6], scope: values?.[7], action: values?.[8],
        target_blocked_state: values?.[9], agent_id: values?.[10], agent_display_name: values?.[11],
        started_at: new Date(String(values?.[12])), completed_at: values?.[13] ? new Date(String(values[13])) : null,
        status: values?.[14], message: values?.[15], error_code: values?.[16], request_path: values?.[17], metadata: values?.[18],
      });
      return result();
    }
    throw new Error("Unexpected audit query.");
  });
  return { client, job, receipts, query };
}

describe("transactional report export audit", () => {
  it.each([
    ["copilot_users", "export-official-usage-users"], ["official_agents", "export-official-usage-aggregate"],
    ["official_users", "export-official-usage-users"], ["graph_packages", "export-package-inventory"],
    ["power_platform_agents", "export-power-platform-inventory"], ["unified_agents", "export-agent-inventory"],
  ] as const)("binds %s receipts to the persisted actor, selection and kind", async (kind, action) => {
    const { client, receipts, query } = fixture(kind);
    await reportExportAudit(client, { ...start, kind });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      event_id: `${id}:build`, operation_id: `data-export:${id}`, tenant_id: actor.tenantId, principal_id: actor.homeAccountId,
      actor_username: actor.username, actor_name: actor.displayName, action, request_path: "/api/data-exports",
      metadata: { source: kind, jobId: id, phase: "build", selection, queryHash: "a".repeat(64),
        mode: "explicit", reportSetId: setId, revision: "17", rowCount: 0, resultingBytes: 0 },
    });
    expect(JSON.stringify(receipts)).not.toContain("private-role");
    expect(query.mock.calls.every(([statement]) => statement !== "COMMIT" && statement !== "BEGIN")).toBe(true);
    expect(client.release).not.toHaveBeenCalled();
  });

  it("records one download attempt with exact finish time and preserves its start identity", async () => {
    const { client, receipts } = fixture();
    const completedAt = new Date(Date.now() + 1000).toISOString();
    await reportExportAudit(client, { ...start, phase: "download" });
    await reportExportAudit(client, { ...start, phase: "download", status: "inconclusive", rows: 2, bytes: 10, checksum: "b".repeat(64) });
    await reportExportAudit(client, { ...start, phase: "download", status: "succeeded", rows: 2, bytes: 10,
      checksum: "b".repeat(64), completedAt });
    expect(receipts.map(receipt => receipt.status)).toEqual(["started", "inconclusive", "succeeded"]);
    expect(new Set(receipts.map(receipt => receipt.event_id))).toEqual(new Set([`${id}:download`]));
    expect(receipts[2].started_at).toEqual(receipts[0].started_at);
    expect(receipts[2].completed_at.toISOString()).toBe(completedAt);
    expect(receipts[2]).toMatchObject({ request_path: `/api/data-exports/${id}/download`, metadata: {
      phase: "download", selection, reportSetId: setId, queryHash: "a".repeat(64), checksum: "b".repeat(64),
    } });
  });

  it("rejects a mismatched persisted kind rather than auditing under a different dataset action", async () => {
    const { client, receipts } = fixture("official_agents");
    await expect(reportExportAudit(client, start)).rejects.toThrow("export_audit_kind");
    expect(receipts).toEqual([]);
  });

  it.each(["tenant", "principal", "username", "displayName"] as const)("rejects invalid recorded %s before appending audit", async field => {
    const { client, job, receipts } = fixture();
    if (field === "tenant") job.actor.tenantId = "different-tenant";
    else if (field === "principal") job.actor.homeAccountId = "different-principal";
    else job.actor[field] = "x".repeat(257);
    await expect(reportExportAudit(client, start)).rejects.toThrow("export_audit_actor");
    expect(receipts).toEqual([]);
  });

  it("keeps cancellation separate from failure while bounding checksum and error evidence", async () => {
    const { client, receipts } = fixture();
    await reportExportAudit(client, start);
    await reportExportAudit(client, { ...start, status: "cancelled", errorCode: "export_cancelled", checksum: "private payload" });
    expect(receipts[1]).toMatchObject({ status: "cancelled", error_code: "export_cancelled" });
    expect(receipts[1].metadata).not.toHaveProperty("checksum");
  });
});
