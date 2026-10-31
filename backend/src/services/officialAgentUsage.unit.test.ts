import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import { digest } from "../db/dataBounds.js";
import * as inventoryAuthority from "../db/inventoryAuthority.js";
import type { CandidateAgentUsageMutation } from "../types/officialReportApi.js";
import { unifiedAgentRecordId } from "../types/unifiedAgents.js";
import type { AuditEvent } from "../types/audit.js";
import { unknownOrigin } from "../types/actionOrigin.js";
import { AuditLog } from "./auditLog.js";
import { OfficialAgentUsage } from "./officialAgentUsage.js";
import { LargeTenantUsersReports, reportQuery, type ReportReadContext } from "./largeTenantUsersReports.js";
import { observeTransactionResult } from "./peakMemory.js";
import type { UserSourceMetadata } from "../types/userSources.js";

const pools: pg.Pool[] = [];
const cleanups: Array<() => void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(pools.splice(0).map(pool => pool.end()));
});

function source(source: UserSourceMetadata["source"]): UserSourceMetadata {
  return { source, generationId: null, scopeId: null, revision: null, expiresAt: null, observedAt: null,
    attemptedAt: null, attemptStatus: null, attemptObservedCount: null, errorCode: null, message: null,
    rowCount: null, state: "unavailable", reportRefreshDate: null, period: null, reportVersion: null };
}

function fixture(expiresAt: string | null = "2026-10-01T00:01:00.000Z", operation: "associate" | "remove" = "associate",
  expireDuringCommit = false) {
  const now = new Date("2026-10-01T00:00:00.000Z");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  const database = new pg.Pool({ max: 4 });
  pools.push(database);
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  vi.spyOn(database, "connect").mockImplementation(() => Promise.resolve(client));
  const databaseQuery = vi.spyOn(database, "query").mockRejectedValue(new Error("Unexpected database query"));
  const reports = new LargeTenantUsersReports(database, "synthetic-usage-expiry-review-secret", 35);
  const identity = { tenantId: "usage-unit-tenant", principalId: "admin", authorizationHash: "admin", sessionEpoch: "1" };
  const actor = { tenantId: identity.tenantId, homeAccountId: identity.principalId,
    username: "admin@example.invalid", displayName: "Admin" };
  const agentId = "11111111-1111-4111-8111-111111111111";
  const selectionId = "22222222-2222-4222-8222-222222222222";
  const reportSetId = "33333333-3333-4333-8333-333333333333";
  const control = "current-control";
  const context: ReportReadContext = {
    identity, endpoint: "official_agents", query: reportQuery("official_agents"), queryHash: "a".repeat(64), evaluatedAt: now,
    metadata: { directory: source("directory"), app_activity: source("app_activity") },
    report: { setId: reportSetId, activeSetId: agentId, activeRevision: "4", historyRevision: "8", historyEpoch: "0",
      availability: "active", staleAfterDays: 35, periodAgeDays: null, acceptedAgeDays: 0,
      acceptedAt: now.toISOString(), expiresAt, reportingPeriod: null, lineages: [] },
    selection: { id: selectionId, revision: "1", evaluatedAt: now.toISOString(), validatedAt: now.toISOString(),
      expiresAt: "2026-10-01T00:10:00.000Z",
      publicationRevisions: { graph_packages: "a".repeat(64), power_platform: "b".repeat(64), users: "c".repeat(64) } },
  };
  const target = { source: "graph_packages" as const, packageId: "Package-A" };
  const existing = { source: target.source, native_id: target.packageId, environment_id: "",
    normalized_native_id: target.packageId, normalized_environment_id: "" };
  let revision = "0", associations = operation === "remove" ? 1 : 0, pending = associations, committed = false;
  const result = (rows: pg.QueryResultRow[] = [], command = "SELECT"): pg.QueryResult =>
    ({ command, rowCount: rows.length, oid: 0, fields: [], rows });
  const query = vi.spyOn(client, "query").mockImplementation(async (sql: string) => {
    if (sql === "BEGIN") return result([], "BEGIN");
    if (sql === "COMMIT") {
      committed = true;
      associations = pending;
      if (expireDuringCommit && expiresAt) vi.setSystemTime(expiresAt);
      return result([], "COMMIT");
    }
    if (sql === "ROLLBACK") { pending = associations; return result([], "ROLLBACK"); }
    if (sql === "SELECT clock_timestamp() AS now") return result([{ now: new Date() }]);
    if (sql.startsWith("SELECT revision::text")) return result([{ revision }]);
    if (sql.includes("SELECT DISTINCT agent_id,control_revision")) return result([{ agent_id: agentId, control_revision: control }]);
    if (sql.includes("SELECT identity FROM official_agents")) return result([{ identity: "Report-A" }]);
    if (sql.startsWith("SELECT * FROM agent_usage_associations")) return result(operation === "remove" ? [existing] : []);
    if (sql.includes("SELECT source,native_id")) return result([existing]);
    if (sql.includes("SELECT 1 FROM sources")) return result([{ exists: true }]);
    if (sql.startsWith("INSERT INTO agent_usage_associations")) { revision = "1"; pending = 1; return result(); }
    if (sql.startsWith("DELETE FROM agent_usage_associations")) { revision = "1"; pending = 0; return result(); }
    throw new Error(`Unexpected unit SQL: ${sql}`);
  });
  vi.spyOn(inventoryAuthority, "lockInventorySelection").mockResolvedValue("1");
  const assertSelection = vi.spyOn(reports.selections, "assert").mockImplementation(async () => {
    if (context.report.expiresAt && Date.parse(context.report.expiresAt) <= Date.now()) throw new AppError(409, "selection_invalidated", "Expired.");
    return { selection: {}, pins: [] };
  });
  vi.spyOn(reports, "contextInRead").mockResolvedValue(context);
  vi.spyOn(reports.history, "lock").mockResolvedValue("history-scope");
  vi.spyOn(reports.history, "lockHead").mockResolvedValue({ active_set_id: agentId, revision: "4" });
  const readable = vi.spyOn(reports, "reportForSelection").mockImplementation(async () => {
    if (context.report.expiresAt && Date.parse(context.report.expiresAt) <= Date.now()) {
      throw new AppError(404, "usage_report_unavailable", "Expired.");
    }
    return context.report;
  });
  let event: AuditEvent;
  vi.spyOn(AuditLog.prototype, "startEvent").mockImplementation(async intent => {
    event = { ...intent, id: "unit-event", startedAt: now.toISOString(), status: "started",
      origin: unknownOrigin };
    return event;
  });
  vi.spyOn(AuditLog.prototype, "getEvent").mockImplementation(async () => ({ ...event, status: committed ? "succeeded" : "started" }));
  const complete = vi.spyOn(AuditLog.prototype, "completeEvent").mockImplementation(async (_id, update) => ({ ...event, ...update }));
  const input: CandidateAgentUsageMutation = { selectionId, reportSetId, reportAgentId: "Report-A", confirmed: true,
    ...(operation === "associate" ? { target } : {}),
    usageRevision: digest(JSON.stringify([context.report, revision])),
    inventoryRevision: digest(JSON.stringify(["inventory-control-v1", identity.tenantId, identity.principalId, agentId, control])) };
  const mutate = () => new OfficialAgentUsage(reports).mutate(identity, unifiedAgentRecordId({ source: "canonical", agentId }), input, actor);
  return { mutate, reports, client, context, query, readable, complete, assertSelection, databaseQuery,
    committed: () => committed, associationCount: () => associations };
}

describe("official usage mutation publication", () => {
  it.each(["associate", "remove"] as const)("rolls back %s when report expiry is crossed after the final selection check but before commit", async operation => {
    const state = fixture("2026-10-01T00:01:00.000Z", operation);
    cleanups.push(observeTransactionResult(async () => {
      expect(state.assertSelection).toHaveBeenCalledTimes(2);
      vi.setSystemTime("2026-10-01T00:01:00.000Z");
      return undefined;
    }));
    await expect(state.mutate()).rejects.toMatchObject({ status: 404, code: "usage_report_unavailable" });
    expect(state.query).toHaveBeenCalledWith("ROLLBACK");
    expect(state.query).not.toHaveBeenCalledWith("COMMIT");
    expect(state.committed()).toBe(false);
    expect(state.associationCount()).toBe(operation === "remove" ? 1 : 0);
    expect(state.complete).toHaveBeenLastCalledWith("unit-event", {
      status: "failed", errorCode: "usage_report_unavailable",
    });
    expect(state.databaseQuery).not.toHaveBeenCalled();
  });

  it.each([
    { operation: "associate" as const, expiresAt: null },
    { operation: "associate" as const, expiresAt: "2026-10-01T00:01:00.001Z" },
    { operation: "remove" as const, expiresAt: null },
    { operation: "remove" as const, expiresAt: "2026-10-01T00:01:00.001Z" },
  ])("commits $operation for a readable retained non-default report expiring at $expiresAt", async ({ operation, expiresAt }) => {
    const state = fixture(expiresAt, operation);
    cleanups.push(observeTransactionResult(async () => { vi.setSystemTime("2026-10-01T00:01:00.000Z"); return undefined; }));
    const result = await state.mutate();
    expect(result.reportSetId).toBe(state.context.report.setId);
    expect(result.reports.activeSetId).not.toBe(result.reportSetId);
    expect(state.committed()).toBe(true);
    expect(state.associationCount()).toBe(operation === "associate" ? 1 : 0);
    expect(state.query).toHaveBeenCalledWith("COMMIT");
    expect(state.databaseQuery).not.toHaveBeenCalled();
  });

  it.each(["associate", "remove"] as const)("does not return an expired %s context or rewrite a durable success when expiry is crossed during commit", async operation => {
    const state = fixture("2026-10-01T00:01:00.000Z", operation, true);
    await expect(state.mutate()).rejects.toMatchObject({ status: 404, code: "usage_report_unavailable" });
    expect(state.committed()).toBe(true);
    expect(state.associationCount()).toBe(operation === "associate" ? 1 : 0);
    expect(state.query).toHaveBeenCalledWith("COMMIT");
    expect(state.query).not.toHaveBeenCalledWith("ROLLBACK");
    expect(state.complete.mock.calls.map(([, update]) => update.status)).toEqual(["succeeded"]);
    expect(state.databaseQuery).not.toHaveBeenCalled();
  });
});
