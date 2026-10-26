import pg from "pg";
import { createHash } from "node:crypto";
import { parse as parseCsv } from "csv-parse/sync";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "../types/session.js";
import { DataExports, type ExportAudit } from "./dataExports.js";
import { DataSelections, type SelectionIdentity } from "./dataSelections.js";
import { reportExportAudit } from "./reportExportAudit.js";
import { AppError } from "../errors.js";
import { observeTransactionResult } from "./peakMemory.js";
import { operationalLog } from "./telemetry.js";
import { LargeTenantUsersReports } from "./largeTenantUsersReports.js";
import { OfficialReportImports } from "../db/officialReportImports.js";
import { OfficialReportExports } from "./officialReportExports.js";
import { ReportExportDispatcher } from "./reportExportDispatcher.js";
import { InventoryQueries } from "../db/inventoryQueries.js";
import { flushDataWorkMetrics } from "./dataMetrics.js";
import { inventoryExportColumns } from "./inventoryExports.js";
import { config } from "../config.js";
import { withAuthority } from "../auth/authorityContext.js";
import type { DelegatedCredentialSource, RequestPrincipal } from "../types/requestPrincipal.js";

function exportAuthority(identity: SelectionIdentity): DelegatedCredentialSource {
  let revoked = false;
  const principal: RequestPrincipal = { ...identity, apiClientId: "synthetic-api", localAccountId: "synthetic-local",
    username: "exporter@example.invalid", displayName: "Exporter", roles: ["AgentControl.Viewer"], providerRoleIds: [],
    transport: "browser", integrationClientId: "synthetic-api", rolesValidatedAt: Date.now(),
    authenticatedAt: Date.now(), expiresAt: Date.now() + 300_000 };
  return { principal, reference: { ...identity, id: "synthetic-export-source", apiClientId: principal.apiClientId,
    transport: principal.transport, integrationClientId: principal.integrationClientId, expiresAt: principal.expiresAt },
    expiresAt: principal.expiresAt, assertCurrent: vi.fn(() => {
      if (revoked || Date.now() >= principal.expiresAt) throw new AppError(401, "authorization_required", "Export authority ended.");
    }), revalidate: async () => { throw new Error("Exports cannot revalidate or obtain provider tokens."); },
    acquire: async () => { throw new Error("Saved exports cannot acquire provider tokens."); }, revoke: () => { revoked = true; } };
}

const configuredTenants = config.tenants;

function exportChunkBatch(values?: unknown[]) {
  const bytes = values?.[3], checksums: unknown = values?.[4], ordinal = Number(values?.[2]);
  if (!Buffer.isBuffer(bytes) || !Array.isArray(checksums) || !bytes.length || bytes.length > 1_048_576
    || checksums.length !== Math.ceil(bytes.length / 262_144) || !Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new Error("Invalid chunk batch.");
  }
  return checksums.map((checksum: unknown, offset: number) => {
    if (typeof checksum !== "string") throw new Error("Invalid chunk checksum.");
    const chunk = Buffer.from(bytes.subarray(offset * 262_144, (offset + 1) * 262_144));
    return { ordinal: ordinal + offset, bytes: chunk, byte_count: chunk.length, checksum };
  });
}

vi.mock("../db/pool.js", () => ({
  pool: {},
  secretValue: (name: string) => name === "TENANTS_JSON" ? "[]"
    : name === "SESSION_SECRET" ? "synthetic-export-audit-session-secret" : undefined,
}));
vi.mock("./telemetry.js", async original => ({
  ...await original<typeof import("./telemetry.js")>(), operationalLog: vi.fn(),
}));

afterEach(() => {
  config.tenants = configuredTenants;
  flushDataWorkMetrics();
  observeTransactionResult(undefined);
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("export dispatcher maintenance admissions", () => {
  function fixture() {
    vi.useFakeTimers();
    vi.stubEnv("MAINTENANCE_MODE", undefined);
    vi.stubEnv("MAINTENANCE_FILE", undefined);
    const database = new pg.Pool({ max: 4 });
    const reports = new LargeTenantUsersReports(database, "synthetic-dispatch-maintenance-secret", 35);
    const state = { mode: "normal" };
    const job = { id: "11111111-1111-4111-8111-111111111111", kind: "official_users",
      tenant_id: "tenant-a", principal_id: "principal-a", authorization_hash: "viewer", session_epoch: "1",
      actor: { tenantId: "tenant-a", homeAccountId: "principal-a", username: "exporter@example.invalid", displayName: "Exporter" } };
    const queuedJobs = vi.fn(() => [job]);
    const query = vi.spyOn(database, "query").mockImplementation(async statement => {
      const sql = String(statement);
      if (sql.includes("FROM operational_state")) return { command: "SELECT", oid: 0, fields: [], rowCount: 1, rows: [{ ...state }] };
      if (sql.startsWith("UPDATE data_exports")) return { command: "UPDATE", oid: 0, fields: [], rowCount: 1, rows: [] };
      if (sql.includes("FROM data_exports")) {
        const rows = queuedJobs();
        return { command: "SELECT", oid: 0, fields: [], rowCount: rows.length, rows };
      }
      throw new Error("Unexpected dispatcher query.");
    });
    const retain = vi.spyOn(reports.sources.connections, "run").mockResolvedValue({});
    const sweep = vi.spyOn(OfficialReportImports.prototype, "sweep").mockResolvedValue(0);
    const expire = vi.spyOn(DataExports.prototype, "expire").mockResolvedValue(0);
    const queued: Awaited<ReturnType<OfficialReportExports["status"]>> = {
      id: job.id, status: "queued", rows: 0, bytes: 0, expiresAt: new Date(Date.now() + 60_000).toISOString(),
      error: null, limit: null, observed: null,
    };
    const status = vi.spyOn(OfficialReportExports.prototype, "status").mockResolvedValue(queued);
    const build = vi.spyOn(OfficialReportExports.prototype, "build").mockResolvedValue();
    const fail = vi.spyOn(DataExports.prototype, "failPending").mockResolvedValue();
    const dispatcher = new ReportExportDispatcher(reports);
    const identity = { tenantId: job.tenant_id, principalId: job.principal_id, authorizationHash: job.authorization_hash, sessionEpoch: job.session_epoch };
    const source = exportAuthority(identity);
    withAuthority(source, () => dispatcher.enqueue(job.id, identity, false));
    return { dispatcher, source, state, job, queuedJobs, query, retain, sweep, expire, status, queued, build, fail };
  }

  it("does not start lifecycle maintenance or exports while the database is in maintenance", async () => {
    const f = fixture();
    f.state.mode = "maintenance";
    f.dispatcher.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.retain).not.toHaveBeenCalled();
    expect(f.sweep).not.toHaveBeenCalled();
    expect(f.status).not.toHaveBeenCalled();
    expect(f.build).not.toHaveBeenCalled();
    await f.dispatcher.drain();
  });

  it("allows saved-data exports in normal mode", async () => {
    const f = fixture();
    f.dispatcher.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.build).toHaveBeenCalledOnce();
    expect(f.fail).not.toHaveBeenCalled();
    await f.dispatcher.drain();
  });

  it("does not borrow a new request's authority for a revoked initiating export", async () => {
    const f = fixture();
    f.status.mockImplementationOnce(async () => { f.source.revoke(); return f.queued; });
    f.dispatcher.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.build).not.toHaveBeenCalled();
    expect(f.fail).not.toHaveBeenCalled();
    await f.dispatcher.drain();
  });

  it("keeps restart work queued for explicit same-principal idempotent reauthorization", async () => {
    const f = fixture(), restarted = new ReportExportDispatcher(f.dispatcher.reports);
    restarted.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.build).not.toHaveBeenCalled();
    expect(f.query).toHaveBeenCalledWith(expect.stringContaining("error_code='authorization_required'"), [f.job.id]);
    await restarted.drain();
    const identity = { tenantId: f.job.tenant_id, principalId: f.job.principal_id,
      authorizationHash: f.job.authorization_hash, sessionEpoch: f.job.session_epoch };
    withAuthority(exportAuthority(identity), () => restarted.enqueue(f.job.id, identity, false));
    restarted.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.build).toHaveBeenCalledOnce();
    await restarted.drain();
  });

  it("does not erase explicit renewed authorization when an older active build settles", async () => {
    const f = fixture();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    f.build.mockImplementationOnce(async () => { await held; f.source.assertCurrent(); });
    f.dispatcher.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.build).toHaveBeenCalledOnce();
    const identity = { tenantId: f.job.tenant_id, principalId: f.job.principal_id,
      authorizationHash: f.job.authorization_hash, sessionEpoch: f.job.session_epoch };
    withAuthority(exportAuthority(identity), () => f.dispatcher.enqueue(f.job.id, identity, false));
    f.source.revoke(); release();
    await vi.advanceTimersByTimeAsync(0);
    f.dispatcher.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.build).toHaveBeenCalledTimes(2);
    await f.dispatcher.drain();
  });

  it.each(["retention", "queue", "expiry", "status"])("leaves work queued when process maintenance begins during %s", async stage => {
    const f = fixture();
    const close = () => vi.stubEnv("MAINTENANCE_MODE", "true");
    if (stage === "retention") f.retain.mockImplementationOnce(async () => { close(); return {}; });
    if (stage === "queue") f.queuedJobs.mockImplementationOnce(() => { close(); return [f.job]; });
    if (stage === "expiry") f.expire.mockImplementationOnce(async () => { close(); return 0; });
    if (stage === "status") f.status.mockImplementationOnce(async () => { close(); return f.queued; });
    f.dispatcher.wake();
    await vi.advanceTimersByTimeAsync(0);
    if (stage === "retention") expect(f.sweep).not.toHaveBeenCalled();
    expect(f.build).not.toHaveBeenCalled();
    expect(f.fail).not.toHaveBeenCalled();
    vi.stubEnv("MAINTENANCE_MODE", undefined);
    f.dispatcher.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.build).toHaveBeenCalledOnce();
    await f.dispatcher.drain();
  });

  it("does not start another cleanup slice when persisted maintenance begins during retention", async () => {
    const f = fixture();
    f.retain.mockImplementationOnce(async () => { f.state.mode = "maintenance"; return {}; });
    f.dispatcher.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.sweep).not.toHaveBeenCalled();
    expect(f.queuedJobs).not.toHaveBeenCalled();
    expect(f.build).not.toHaveBeenCalled();
    expect(f.fail).not.toHaveBeenCalled();
    f.state.mode = "normal";
    f.dispatcher.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.build).toHaveBeenCalledOnce();
    await f.dispatcher.drain();
  });

  it("joins in-flight cleanup at shutdown without admitting the next slice", async () => {
    const f = fixture();
    const retention = Promise.withResolvers<{}>();
    f.retain.mockReturnValueOnce(retention.promise);
    f.dispatcher.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.retain).toHaveBeenCalledOnce();
    const draining = f.dispatcher.drain();
    retention.resolve({});
    await draining;
    expect(f.sweep).not.toHaveBeenCalled();
    expect(f.queuedJobs).not.toHaveBeenCalled();
    expect(f.build).not.toHaveBeenCalled();
  });

  it.each(["ensure", "expiry", "collection"] as const)("pauses the next tenant lifecycle slice after closure during %s", async stage => {
    const f = fixture();
    config.tenants = ["tenant-a", "tenant-b"].map(tenantId => ({
      tenantId, clientId: "22222222-2222-4222-8222-222222222222", clientSecret: "synthetic-dispatch-tenant-secret",
      domains: ["example.invalid"], displayName: "Synthetic tenant",
    }));
    const close = () => {
      if (stage === "ensure") vi.stubEnv("MAINTENANCE_MODE", "true");
      else f.state.mode = "maintenance";
    };
    const ensure = vi.spyOn(f.dispatcher.reports.history, "ensure").mockImplementation(async () => {
      if (stage === "ensure") close();
      return "history-scope";
    });
    const expire = vi.spyOn(f.dispatcher.reports.history, "expire").mockImplementation(async () => {
      if (stage === "expiry") close();
      return 0;
    });
    const collect = vi.spyOn(f.dispatcher.reports.history, "collect").mockImplementation(async () => {
      if (stage === "collection") close();
      return 0;
    });
    f.dispatcher.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(ensure).toHaveBeenCalledExactlyOnceWith("tenant-a");
    if (stage === "ensure") expect(expire).not.toHaveBeenCalled();
    else expect(expire).toHaveBeenCalledExactlyOnceWith("tenant-a");
    if (stage === "collection") expect(collect).toHaveBeenCalledExactlyOnceWith("tenant-a");
    else expect(collect).not.toHaveBeenCalled();
    expect(f.queuedJobs).not.toHaveBeenCalled();
    expect(f.build).not.toHaveBeenCalled();
    await f.dispatcher.drain();
  });

  it("rechecks persisted maintenance after awaited export status before building", async () => {
    const f = fixture();
    f.status.mockImplementationOnce(async () => { f.state.mode = "maintenance"; return f.queued; });
    f.dispatcher.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.build).not.toHaveBeenCalled();
    expect(f.fail).not.toHaveBeenCalled();
    f.state.mode = "normal";
    f.dispatcher.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.build).toHaveBeenCalledOnce();
    await f.dispatcher.drain();
  });

  it("does not start a build after shutdown overtakes an awaited status read", async () => {
    const f = fixture();
    const status = Promise.withResolvers<Awaited<ReturnType<OfficialReportExports["status"]>>>();
    f.status.mockReturnValueOnce(status.promise);
    f.dispatcher.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.status).toHaveBeenCalledOnce();
    const draining = f.dispatcher.drain();
    status.resolve(f.queued);
    await draining;
    expect(f.build).not.toHaveBeenCalled();
    expect(f.fail).not.toHaveBeenCalled();
  });

  it.each(["read failure", "missing singleton", "invalid mode", "duplicate singleton"])(
    "keeps exports queued when the final maintenance check has a %s", async outcome => {
    const f = fixture();
    vi.mocked(operationalLog).mockClear();
    f.status.mockImplementationOnce(async () => {
      if (outcome === "read failure") f.query.mockRejectedValueOnce(new Error("Private database detail."));
      else if (outcome === "missing singleton") f.query.mockImplementationOnce(async () => ({ command: "SELECT", oid: 0, fields: [], rowCount: 0, rows: [] }));
      else {
        const row = { mode: outcome === "invalid mode" ? "invalid" : "normal" };
        const rows = outcome === "duplicate singleton" ? [row, row] : [row];
        f.query.mockImplementationOnce(async () => ({ command: "SELECT", oid: 0, fields: [], rowCount: rows.length, rows }));
      }
      return f.queued;
    });
    f.dispatcher.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.build).not.toHaveBeenCalled();
    expect(f.fail).not.toHaveBeenCalled();
    expect(operationalLog).toHaveBeenCalledWith("error", "report_export_dispatch_failed",
      { errorCode: "internal_error", errorKind: "unexpected" });
    expect(JSON.stringify(vi.mocked(operationalLog).mock.calls)).not.toContain("Private database detail.");
    f.dispatcher.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.build).toHaveBeenCalledOnce();
    await f.dispatcher.drain();
  });

  it("aborts active builds immediately even while shutdown joins an in-flight cleanup slice", async () => {
    const f = fixture();
    const building = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    f.build.mockImplementationOnce(async (_id, _identity, _kind, currentSignal) => {
      signal = currentSignal;
      currentSignal?.addEventListener("abort", () => building.resolve(), { once: true });
      await building.promise;
    });
    f.dispatcher.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.build).toHaveBeenCalledOnce();
    const retention = Promise.withResolvers<{}>();
    f.retain.mockReturnValueOnce(retention.promise);
    f.dispatcher.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.retain).toHaveBeenCalledTimes(2);
    const draining = f.dispatcher.drain();
    expect(signal?.aborted).toBe(true);
    retention.resolve({});
    await draining;
    expect(f.fail).not.toHaveBeenCalled();
  });

  it("leaves queued admission retryable when shutdown aborts before the builder owns a lease", async () => {
    const f = fixture();
    f.build.mockImplementationOnce(async (_id, _identity, _kind, signal) => {
      await new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    f.dispatcher.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.build).toHaveBeenCalledOnce();
    await f.dispatcher.drain();
    expect(f.fail).not.toHaveBeenCalled();
  });

  it.each(["expiry", "status", "preflight"] as const)("retries unowned work after a transient %s failure without a failed receipt", async stage => {
    const f = fixture();
    const transient = new AppError(503, "data_read_conflict", "Retry the selected read.");
    if (stage === "expiry") f.expire.mockRejectedValueOnce(transient);
    if (stage === "status") f.status.mockRejectedValueOnce(transient);
    if (stage === "preflight") f.build.mockRejectedValueOnce(transient);
    f.dispatcher.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.fail).not.toHaveBeenCalled();
    f.dispatcher.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.build).toHaveBeenCalledTimes(stage === "preflight" ? 2 : 1);
    await f.dispatcher.drain();
  });

  it("does not turn an unexpected pre-claim database outage into a terminal queued failure", async () => {
    const f = fixture();
    f.build.mockRejectedValueOnce(new Error("Private acquisition detail."));
    f.dispatcher.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.fail).not.toHaveBeenCalled();
    f.dispatcher.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.build).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(vi.mocked(operationalLog).mock.calls)).not.toContain("Private acquisition detail.");
    await f.dispatcher.drain();
  });

  it("excludes active work from the next bounded discovery instead of letting it occupy the queue head", async () => {
    const f = fixture();
    f.build.mockImplementationOnce(async (_id, _identity, _kind, signal) => {
      await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }));
    });
    f.dispatcher.wake();
    await vi.advanceTimersByTimeAsync(0);
    f.dispatcher.wake();
    await vi.advanceTimersByTimeAsync(0);
    const discovery = f.query.mock.calls.filter(([statement]) => String(statement).includes("WITH candidates"));
    expect(discovery.map(([, values]) => values)).toEqual([[[], 4, []], [[f.job.id], 3, [f.job.tenant_id]]]);
    expect(f.build).toHaveBeenCalledOnce();
    await f.dispatcher.drain();
  });

  it("does not reopen admissions when start races a still-pending drain", async () => {
    const f = fixture();
    const retention = Promise.withResolvers<{}>();
    f.retain.mockReturnValueOnce(retention.promise);
    f.dispatcher.wake();
    await vi.advanceTimersByTimeAsync(0);
    const draining = f.dispatcher.drain();
    f.dispatcher.start();
    f.dispatcher.wake();
    retention.resolve({});
    await draining;
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.build).not.toHaveBeenCalled();
    f.dispatcher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.build).toHaveBeenCalledOnce();
    await f.dispatcher.drain();
  });

  it.each(["before", "during"] as const)("rejects shutdown when owned settlement fails %s drain, without losing its original abort reason", async phase => {
    const f = fixture();
    const admitted = Promise.withResolvers<void>();
    f.build.mockImplementationOnce(async (_id, _identity, _kind, signal, control) => {
      if (phase === "before") control?.settlementFailed?.(new AggregateError([new Error("Synthetic settlement failure.")],
        "export_work_and_settlement_failed"));
      admitted.resolve();
      await new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => {
        if (phase === "during") control?.settlementFailed?.(new AggregateError([signal.reason, new Error("Synthetic settlement failure.")],
          "export_work_and_settlement_failed"));
        reject(signal.reason);
      }, { once: true }));
    });
    f.dispatcher.wake();
    await admitted.promise;
    await expect(f.dispatcher.drain()).rejects.toMatchObject({ message: "export_work_and_settlement_failed" });
    expect(f.fail).not.toHaveBeenCalled();
  });
});

describe("export audit actor persistence", () => {
  it("persists only recorded identity fields from a session user and still appends its scoped audit receipt", async () => {
    const identity: SelectionIdentity = {
      tenantId: "export-tenant", principalId: "export-principal", authorizationHash: "viewer", sessionEpoch: "1",
    };
    const recordedActor = { tenantId: identity.tenantId, homeAccountId: identity.principalId,
      username: "exporter@example.invalid", displayName: "Exporter" };
    const actor: AuthenticatedUser = { ...recordedActor, roles: ["AgentControl.Viewer"], providerRoleIds: ["provider-role"] };
    const database = new pg.Pool({ max: 4 });
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    vi.spyOn(database, "connect").mockImplementation(async () => client);
    const databaseQuery = vi.spyOn(database, "query").mockRejectedValue(new Error("Unexpected pool query."));
    const result = (rows: object[] = []) => ({ command: "", oid: 0, fields: [], rowCount: rows.length, rows });
    let serializedActor: string | undefined;
    const query = vi.fn(async (statement: unknown, values?: unknown[]) => {
      if (typeof statement !== "string") throw new Error("Unexpected query shape.");
      if (statement === "COMMIT") return { ...result(), command: "COMMIT" };
      if (statement.startsWith("SELECT count(*)::int AS n")) return result([{ n: 0 }]);
      if (statement.startsWith("INSERT INTO data_exports")) {
        if (typeof values?.[9] !== "string") throw new Error("Missing export actor.");
        serializedActor = values[9];
        return result();
      }
      if (statement.startsWith("SELECT e.tenant_id,e.principal_id,e.actor")) {
        return result([{ tenant_id: identity.tenantId, principal_id: identity.principalId,
          actor: JSON.parse(serializedActor ?? "null"), kind: "official_agents", selection_id: "11111111-1111-4111-8111-111111111111",
          query_hash: "a".repeat(64), selection_mode: "all", set_id: null }]);
      }
      if (["BEGIN", "ROLLBACK", "SELECT pg_advisory_xact_lock(3650148)"].includes(statement)
        || statement.startsWith("INSERT INTO audit_events")) return result();
      throw new Error("Unexpected export database query.");
    });
    vi.spyOn(client, "query").mockImplementation(query);
    const selections = new DataSelections(database);
    vi.spyOn(selections, "assert").mockResolvedValue({
      selection: { query_hash: "a".repeat(64) }, pins: [{ expires_at: new Date(Date.now() + 60_000) }],
    });

    await new DataExports(database, selections, reportExportAudit).create(identity, {
      selectionId: "11111111-1111-4111-8111-111111111111", queryHash: "a".repeat(64),
      kind: "official_agents", filename: "official-agents.csv", actor,
    });

    expect(JSON.parse(serializedActor ?? "null")).toEqual(recordedActor);
    const receipt = query.mock.calls.find(([statement]) => typeof statement === "string" && statement.startsWith("INSERT INTO audit_events"));
    expect(receipt?.[1]?.slice(3, 7)).toEqual([identity.tenantId, identity.principalId, actor.username, actor.displayName]);
    expect(actor).toEqual({ ...recordedActor, roles: ["AgentControl.Viewer"], providerRoleIds: ["provider-role"] });
    expect(query).toHaveBeenCalledWith("COMMIT");
    expect(query).not.toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
    expect(databaseQuery).not.toHaveBeenCalled();
  });
});

describe("durable CSV encoding", () => {
  it("preserves formula-safe fields across UTF-8 chunk boundaries and persists exact counts and checksums", async () => {
    const identity: SelectionIdentity = {
      tenantId: "export-tenant", principalId: "export-principal", authorizationHash: "viewer", sessionEpoch: "1",
    };
    const database = new pg.Pool({ max: 4 });
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    const selections = new DataSelections(database);
    vi.spyOn(selections, "assert").mockResolvedValue({ selection: { query_json: {}, query_hash: "a".repeat(64) }, pins: [] });
    const audit = vi.fn(async () => undefined);
    const engine = new DataExports(database, selections, audit);
    vi.spyOn(engine.connections, "run").mockImplementation(async work => work(client));
    vi.spyOn(engine.connections, "selectedRead").mockImplementation(async work => work(client));
    const metadata = {
      selection_id: "selection", query_hash: "a".repeat(64), status: "queued", lease_version: 0, kind: "graph_packages", selection_mode: "all",
      deadline_at: new Date(Date.now() + 60_000), expires_at: new Date(Date.now() + 60_000), lease_until: new Date(Date.now() + 60_000),
      row_count: 0, byte_count: 0, chunk_count: 0, checksum: "",
    };
    const chunks: Array<{ bytes: Buffer; byte_count: number; checksum: string }> = [];
    const result = (rows: object[] = []) => ({ command: "", oid: 0, fields: [], rowCount: rows.length, rows });
    vi.spyOn(client, "query").mockImplementation(async (statement: unknown, values?: unknown[]) => {
      if (typeof statement !== "string") throw new Error("Unexpected query shape.");
      if (statement.startsWith("SELECT mode FROM operational_state")) return result([{ mode: "normal" }]);
      if (statement.startsWith("SELECT selection_id FROM data_exports")) return result([{ selection_id: metadata.selection_id }]);
      if (statement.startsWith("SELECT * FROM data_exports")) return result([metadata]);
      if (statement.startsWith("SELECT count(*)::int AS global")) return result([{ global: 0, tenant: 0 }]);
      if (statement.startsWith("SELECT id FROM data_exports")) return result([{ id: "export" }]);
      if (statement.startsWith("INSERT INTO data_export_chunks")) {
        chunks.push(...exportChunkBatch(values));
        return result();
      }
      if (statement.startsWith("UPDATE data_exports SET row_count")) {
        Object.assign(metadata, { row_count: values?.[1], byte_count: values?.[2], chunk_count: values?.[3] });
        return result();
      }
      if (statement.startsWith("SELECT bytes,byte_count,checksum")) {
        const start = Number(values?.[1]);
        return result(chunks.slice(start, Number(values?.[2] ?? start + 1))
          .map((chunk, offset) => ({ ...chunk, ordinal: start + offset })));
      }
      if (statement.startsWith("SELECT count(*)::int AS chunks")) return result([{
        chunks: chunks.length, bytes: chunks.reduce((sum, chunk) => sum + chunk.byte_count, 0), last: chunks.length - 1,
      }]);
      if (statement.startsWith("UPDATE data_exports SET status='ready'")) {
        Object.assign(metadata, { status: "ready", checksum: values?.[1] });
        return result();
      }
      if (statement.startsWith("UPDATE data_exports SET status='building'")) return result([{ lease_until: metadata.lease_until }]);
      if (statement === "SELECT pg_advisory_xact_lock(3650148)") return result();
      throw new Error("Unexpected export database query.");
    });

    const formula = "\n=1";
    const wideText = `  +${"界😀".repeat(40_000)},"quoted"\r\n`;
    await engine.build("export", identity, ["Name", "disabled"], async function* () {
      yield [{ Name: formula, disabled: false, internalField: "not exported" }, { Name: wideText, disabled: null }];
    });

    const buffer = Buffer.concat(chunks.map(chunk => chunk.bytes));
    const rows = parseCsv<Record<string, string>>(buffer, { bom: true, columns: true });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ Name: `'${formula}`, disabled: "false" });
    expect(rows[1].disabled).toBe("");
    expect(createHash("sha256").update(rows[1].Name).digest("hex"))
      .toBe(createHash("sha256").update(`'${wideText}`).digest("hex"));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(chunk => chunk.byte_count <= 262_144)).toBe(true);
    const checksum = createHash("sha256").update(buffer).digest("hex");
    expect(metadata).toMatchObject({ status: "ready", row_count: 2, byte_count: buffer.length, chunk_count: chunks.length, checksum });
    expect(audit).toHaveBeenLastCalledWith(client, expect.objectContaining({ status: "succeeded", rows: 2, bytes: buffer.length, checksum }));
  });
});

function lifecycle() {
      const identity: SelectionIdentity = {
        tenantId: "export-tenant", principalId: "export-principal", authorizationHash: "viewer", sessionEpoch: "1",
      };
      const id = "11111111-1111-4111-8111-111111111111";
      const database = new pg.Pool({ max: 4 });
      const client = Object.assign(new pg.Client(), { release: vi.fn() });
      vi.spyOn(database, "connect").mockImplementation(async () => client);
      vi.spyOn(database, "query").mockRejectedValue(new Error("Unexpected pool query."));
      const selections = new DataSelections(database);
      vi.spyOn(selections, "assert").mockResolvedValue({
        selection: { query_json: {}, query_hash: "a".repeat(64) },
        pins: [{ expires_at: new Date(Date.now() + 60_000) }],
      });
      const audit = vi.fn<ExportAudit>();
      audit.mockResolvedValue(undefined);
      const engine = new DataExports(database, selections, audit);
      const metadata = {
        selection_id: "selection", query_hash: "a".repeat(64), status: "queued", owner: null as string | null, lease_version: 0,
        kind: "official_users", selection_mode: "all", deadline_at: new Date(Date.now() + 60_000),
        expires_at: new Date(Date.now() + 60_000), lease_until: new Date(Date.now() + 60_000),
        row_count: 0, byte_count: 0, chunk_count: 0, checksum: "",
        error_code: null as string | null, error_limit: null, error_observed: null,
      };
      const chunks = new Map<number, { bytes: Buffer; byte_count: number; checksum: string }>();
      const selectedIds: string[] = [];
      const result = (rows: object[] = []) => ({ command: "", oid: 0, fields: [], rowCount: rows.length, rows });
      let snapshot: typeof metadata | undefined;
      let savedChunks = new Map(chunks);
      const queryWork = async (statement: unknown, values?: unknown[]) => {
        if (typeof statement !== "string") throw new Error("Unexpected query shape.");
        if (statement.startsWith("BEGIN")) { snapshot = { ...metadata }; savedChunks = new Map(chunks); return result(); }
        if (statement === "ROLLBACK") {
          if (snapshot) Object.assign(metadata, snapshot);
          chunks.clear(); savedChunks.forEach((chunk, ordinal) => chunks.set(ordinal, chunk));
          return result();
        }
        if (statement === "COMMIT") return { ...result(), command: "COMMIT" };
        if (statement.startsWith("SELECT pg_advisory")) {
          return result(statement.includes("unlock") ? [{ unlocked: true }] : []);
        }
        if (statement.startsWith("SELECT mode FROM operational_state")) return result([{ mode: "normal" }]);
        if (statement.startsWith("SELECT selection_id FROM data_exports")) return result([{ selection_id: metadata.selection_id }]);
        if (statement.startsWith("SELECT * FROM data_exports")) return result(metadata.expires_at.getTime() > Date.now() ? [metadata] : []);
        if (statement.startsWith("SELECT e.id,e.status")) return result();
        if (statement.startsWith("SELECT count(*)::int AS n")) return result([{ n: 0 }]);
        if (statement.startsWith("SELECT count(*)::int AS global")) return result([{ global: 0, tenant: 0 }]);
        if (statement.startsWith("SELECT id FROM data_exports")) return result(metadata.status === "building"
          && metadata.owner === values?.[1] && metadata.lease_version === values?.[2]
          && metadata.deadline_at.getTime() > Date.now() && metadata.lease_until.getTime() > Date.now() ? [{ id }] : []);
        if (statement.startsWith("SELECT ordinal,identity FROM data_export_items")) return result(
          selectedIds.map((identity, ordinal) => ({ identity, ordinal }))
            .filter(row => row.ordinal > Number(values?.[2])).slice(0, 250));
        if (statement.startsWith("UPDATE data_exports SET status='building'")) {
          Object.assign(metadata, { status: "building", owner: values?.[1], lease_version: metadata.lease_version + 1 });
          return result([{ lease_until: metadata.lease_until }]);
        }
        if (statement.startsWith("UPDATE data_exports SET lease_until")) {
          metadata.lease_until = new Date(Math.min(metadata.deadline_at.getTime(), Date.now() + 60_000));
          return result();
        }
        if (statement.startsWith("INSERT INTO data_export_chunks")) {
          for (const chunk of exportChunkBatch(values)) chunks.set(chunk.ordinal, chunk);
          return result();
        }
        if (statement.startsWith("UPDATE data_exports SET row_count")) {
          Object.assign(metadata, { row_count: values?.[1], byte_count: values?.[2], chunk_count: values?.[3] });
          return result();
        }
        if (statement.startsWith("SELECT bytes,byte_count,checksum")) {
          const start = Number(values?.[1]), end = Number(values?.[2] ?? start + 1);
          return result([...chunks.entries()].filter(([ordinal]) => ordinal >= start && ordinal < end)
            .sort(([left], [right]) => left - right).map(([ordinal, chunk]) => ({ ...chunk, ordinal })));
        }
        if (statement.startsWith("SELECT count(*)::int AS chunks")) return result([{
          chunks: chunks.size, bytes: [...chunks.values()].reduce((sum, chunk) => sum + chunk.byte_count, 0),
          last: Math.max(-1, ...chunks.keys()),
        }]);
        if (statement.startsWith("UPDATE data_exports SET status='ready'")) {
          Object.assign(metadata, { status: "ready", checksum: values?.[1] });
          return result();
        }
        if (statement.startsWith("UPDATE data_exports SET status=$7")) {
          if (metadata.status !== "building" || metadata.owner !== values?.[1] || metadata.lease_version !== values?.[2]) return result();
          Object.assign(metadata, { status: values?.[6], error_code: values?.[3] });
          return result([metadata]);
        }
        if (statement.startsWith("UPDATE data_exports SET status='cancelled'")) { metadata.status = "cancelled"; return result(); }
        if (statement.startsWith("INSERT INTO data_exports")) return result();
        throw new Error(`Unexpected lifecycle query: ${statement}`);
      };
      const query = vi.spyOn(client, "query").mockImplementation(queryWork);
      const build = (name?: string) => engine.build(id, identity, ["Name"], async function* () {
        if (name !== undefined) yield [{ Name: name }];
      });
      return { id, identity, database, client, query, queryWork, engine, metadata, chunks, selectedIds, selections, audit, build };
    }

function inventoryLifecycle() {
  const fixture = lifecycle();
  fixture.metadata.kind = "unified_agents";
  const inventory = new InventoryQueries(fixture.database, "synthetic-export-inventory-regression-secret", 35);
  const association = { revision: "1" };
  const result = (rows: object[] = []) => ({ command: "", oid: 0, fields: [], rowCount: rows.length, rows });
  const original = fixture.queryWork;
  fixture.query.mockImplementation(async (statement: unknown, values?: unknown[]) => {
    if (typeof statement !== "string") throw new Error("Unexpected inventory query shape.");
    if (statement.startsWith("INSERT INTO data_principal_epochs")) return result();
    if (statement.startsWith("SELECT epoch FROM data_principal_epochs")) return result([{ epoch: fixture.identity.sessionEpoch }]);
    if (statement.startsWith("SELECT invalidated_at,expires_at<=clock_timestamp()")) {
      return result([{ invalidated_at: null, expired: false }]);
    }
    if (statement.startsWith("SELECT *,expires_at<=clock_timestamp()")) return result([{
      scope_id: "inventory-root", scope_epoch: "1", session_epoch: "1", root_kind: "inventory_delta",
      generation_id: "inventory-baseline", revision: "1", expires_at: fixture.metadata.expires_at, expired: false,
    }]);
    if (statement.startsWith("SELECT * FROM data_scope_epochs")) return result([{
      tenant_id: fixture.identity.tenantId, principal_id: fixture.identity.principalId, epoch: "1", session_epoch: "1",
    }]);
    if (statement.startsWith("SELECT g.id FROM data_generations")) return result([{ id: "inventory-baseline" }]);
    if (statement.startsWith("SELECT 1 FROM inventory_revisions")) {
      expect(values).toEqual(["inventory-root", "1", "inventory-baseline", fixture.identity.tenantId, [fixture.identity.principalId], ""]);
      return result([{}]);
    }
    if (statement.startsWith("SELECT 1 FROM inventory_read_contexts c")) {
      expect(values).toEqual(["selection", fixture.identity.tenantId, "inventory-root"]);
      return result(association.revision === "1" ? [] : [{}]);
    }
    if (statement.startsWith("SELECT *,clock_timestamp() AS validated_at")) return result([{
      root_count: 1, query_json: {}, query_hash: "a".repeat(64), endpoint: "inventory",
      validated_at: new Date(), expired: false, dependencies_expired: false,
    }]);
    return original(statement, values);
  });
  vi.mocked(fixture.selections.assert).mockImplementation(inventory.selections.assert.bind(inventory.selections));
  return { ...fixture, association };
}

    describe("service-free durable export lifecycle", () => {
      it.each(["global", "tenant"] as const)("keeps rejected %s capacity admission queued without starting a producer", async limit => {
        const { id, identity, engine, metadata, query, queryWork, audit } = lifecycle();
        query.mockImplementation(async (statement: unknown, values?: unknown[]) => {
          if (typeof statement === "string" && statement.startsWith("SELECT count(*)::int AS global")) {
            return { command: "SELECT", oid: 0, fields: [], rowCount: 1,
              rows: [{ global: limit === "global" ? 4 : 2, tenant: limit === "tenant" ? 2 : 0 }] };
          }
          return queryWork(statement, values);
        });
        const source = vi.fn(async function* () {});
        await expect(engine.build(id, identity, ["Name"], source)).rejects.toMatchObject({ code: "export_admission" });
        expect(metadata).toMatchObject({ status: "queued", owner: null, lease_version: 0 });
        expect(source).not.toHaveBeenCalled();
        expect(audit).not.toHaveBeenCalled();
      });

      it.each(["maintenance", "shutdown", "deadline", "lease"] as const)("rolls back claim admission when %s overtakes the pre-COMMIT fence", async boundary => {
        vi.useFakeTimers({ toFake: ["Date"] });
        const { id, identity, engine, metadata, query, audit } = lifecycle();
        const parent = new AbortController();
        if (boundary === "lease") metadata.deadline_at = metadata.expires_at = new Date(Date.now() + 120_000);
        observeTransactionResult(async () => {
          if (metadata.status === "building") {
            if (boundary === "maintenance") vi.stubEnv("MAINTENANCE_MODE", "true");
            if (boundary === "shutdown") parent.abort(new Error("export_shutdown"));
            if (boundary === "deadline") vi.setSystemTime(metadata.deadline_at);
            if (boundary === "lease") vi.setSystemTime(metadata.lease_until);
          }
          return undefined;
        });
        const source = vi.fn(async function* () {});
        const building = engine.build(id, identity, ["Name"], source, parent.signal);
        if (boundary === "maintenance") await expect(building).rejects.toMatchObject({ code: "maintenance" });
        else await expect(building).rejects.toThrow(boundary === "shutdown" ? "export_shutdown"
          : boundary === "deadline" ? "export_deadline" : "export_fenced");
        expect(metadata).toMatchObject({ status: "queued", owner: null, lease_version: 0 });
        expect(query).toHaveBeenCalledWith("ROLLBACK");
        expect(source).not.toHaveBeenCalled();
        expect(audit).not.toHaveBeenCalled();
      });

      it("rolls back a staged claim when persisted maintenance closes during admission", async () => {
        const { id, identity, engine, metadata, query, queryWork, audit } = lifecycle();
        query.mockImplementation(async (statement: unknown, values?: unknown[]) => {
          if (typeof statement === "string" && statement.startsWith("SELECT mode FROM operational_state")) {
            return { command: "SELECT", oid: 0, fields: [], rowCount: 1,
              rows: [{ mode: metadata.status === "building" ? "maintenance" : "normal" }] };
          }
          return queryWork(statement, values);
        });
        const source = vi.fn(async function* () {});
        await expect(engine.build(id, identity, ["Name"], source)).rejects.toMatchObject({ code: "maintenance" });
        expect(metadata).toMatchObject({ status: "queued", owner: null, lease_version: 0 });
        expect(source).not.toHaveBeenCalled();
        expect(audit).not.toHaveBeenCalled();
      });

      it.each(["release", "unlock"] as const)("keeps ownership and completes an acknowledged claim after %s cleanup fails", async phase => {
        const { build, client, metadata, query, queryWork, audit } = lifecycle();
        if (phase === "release") client.release.mockImplementationOnce(() => { throw new Error("Synthetic claim release failure."); });
        else {
          let once = true;
          query.mockImplementation(async (statement: unknown, values?: unknown[]) => {
            if (once && typeof statement === "string" && statement.startsWith("SELECT pg_advisory_unlock")) {
              once = false;
              throw new Error("Synthetic claim unlock failure.");
            }
            return queryWork(statement, values);
          });
        }
        await expect(build("claimed")).resolves.toBeUndefined();
        expect(metadata).toMatchObject({ status: "ready", row_count: 1 });
        expect(audit.mock.calls.map(([, event]) => event.status)).toEqual(["succeeded"]);
      });

      it("settles a committed claim aborted during cleanup before entering its producer", async () => {
        const { id, identity, engine, client, metadata, audit } = lifecycle();
        const parent = new AbortController(), reason = new Error("export_shutdown");
        client.release.mockImplementationOnce(() => { parent.abort(reason); throw new Error("Synthetic claim cleanup failure."); });
        const source = vi.fn(async function* () {});
        await expect(engine.build(id, identity, ["Name"], source, parent.signal)).rejects.toBe(reason);
        expect(metadata).toMatchObject({ status: "cancelled", error_code: "export_shutdown" });
        expect(source).not.toHaveBeenCalled();
        expect(audit.mock.calls.map(([, event]) => event.status)).toEqual(["cancelled"]);
      });

      it("fences an aborted lease once before a non-cooperative producer returns", async () => {
        const { id, identity, engine, metadata, audit } = lifecycle();
        const parent = new AbortController(), reason = new Error("export_shutdown");
        const entered = Promise.withResolvers<void>(), resumed = Promise.withResolvers<void>();
        const building = engine.build(id, identity, ["Name"], async function* () {
          entered.resolve();
          await resumed.promise;
          yield [{ Name: "must not publish" }];
        }, parent.signal);
        const rejection = expect(building).rejects.toBe(reason);
        await entered.promise;
        parent.abort(reason);
        await vi.waitFor(() => expect(metadata.status).toBe("cancelled"));
        expect(audit.mock.calls.map(([, event]) => event.status)).toEqual(["cancelled"]);
        resumed.resolve();
        await rejection;
        expect(audit).toHaveBeenCalledOnce();
      });

      it("reports owned settlement failure separately while retaining the producer error", async () => {
        const { id, identity, engine, metadata, audit } = lifecycle();
        const primary = new Error("Synthetic producer failure."), secondary = new Error("Synthetic settlement failure.");
        audit.mockRejectedValue(secondary);
        const settlementFailed = vi.fn();
        await expect(engine.build(id, identity, ["Name"], async function* () { throw primary; },
          undefined, { settlementFailed })).rejects.toBe(primary);
        expect(settlementFailed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
          message: "export_work_and_settlement_failed", errors: [primary, secondary],
        }));
        expect(metadata.status).toBe("building");
      });

      it("does not report failed persistence when terminal settlement COMMIT succeeded before cleanup failed", async () => {
        const { id, identity, engine, client, metadata, audit } = lifecycle();
        const primary = new Error("Synthetic producer failure.");
        audit.mockImplementation(async () => {
          client.release.mockImplementationOnce(() => { throw new Error("Synthetic settlement cleanup failure."); });
        });
        const settlementFailed = vi.fn();
        await expect(engine.build(id, identity, ["Name"], async function* () { throw primary; },
          undefined, { settlementFailed })).rejects.toBe(primary);
        expect(metadata.status).toBe("failed");
        expect(settlementFailed).not.toHaveBeenCalled();
      });

      it("persists the original explicit intent across awaited item batches", async () => {
        const { identity, engine, client, queryWork, audit } = lifecycle();
        const ids = Array.from({ length: 251 }, (_, index) => `package-${index}`);
        const expected = [...ids], saved: string[] = [];
        const input: Parameters<DataExports["create"]>[1] = {
          selectionId: "selection", queryHash: "a".repeat(64), kind: "graph_packages",
          filename: "packages.csv", ids, idempotencyKey: "11111111-1111-4111-8111-111111111111",
        };
        vi.spyOn(client, "query").mockImplementation(async (statement: unknown, values?: unknown[]) => {
          if (typeof statement === "string" && statement.startsWith("SELECT id,request_hash FROM data_exports")) {
            return { command: "SELECT", oid: 0, fields: [], rowCount: 0, rows: [] };
          }
          if (typeof statement === "string" && statement.startsWith("INSERT INTO data_export_items")) {
            const rows = JSON.parse(String(values?.[2])) as Array<{ identity: string }>;
            saved.push(...rows.map(row => row.identity));
            ids[250] = "changed-source";
            input.kind = "official_users";
            return { command: "INSERT", oid: 0, fields: [], rowCount: rows.length, rows: [] };
          }
          return queryWork(statement, values);
        });
        await engine.create(identity, input);
        expect(saved).toEqual(expected);
        expect(audit).toHaveBeenCalledWith(client, expect.objectContaining({ kind: "graph_packages", status: "started" }));
      });

      it("persists distinct empty/null cells and deterministic nested evidence at the durable encoder boundary", async () => {
        const { engine, identity, id, metadata, chunks } = lifecycle();
        const columns = ["missing", "empty", "zero", "enabled", "evidence"];
        await engine.build(id, identity, columns, async function* () {
          yield [
            { missing: null, empty: "", zero: 0, enabled: false, evidence: { z: "=formula", a: { y: [], x: false } } },
            { empty: "", zero: 0, enabled: false, evidence: { a: { x: false, y: [] }, z: "=formula" } },
          ];
        });
        const bytes = Buffer.concat([...chunks.values()].map(chunk => chunk.bytes));
        const [, first, second] = bytes.toString().split("\r\n");
        expect(first).toBe(second);
        expect(first.startsWith(',"","0","false",')).toBe(true);
        expect(parseCsv<Record<string, string>>(bytes, { columns: true, bom: true }).map(row => JSON.parse(row.evidence)))
          .toEqual(Array.from({ length: 2 }, () => ({ a: { x: false, y: [] }, z: "=formula" })));
        expect(metadata).toMatchObject({ status: "ready", row_count: 2, byte_count: bytes.length });
      });

      it.each([["id", "id"], Array.from({ length: 129 }, (_, index) => `column${index}`)].map(columns => ({ columns })))(
        "rejects an ambiguous or oversized durable schema before admitting any producer", async ({ columns }) => {
          const { engine, identity, id, query, chunks } = lifecycle();
          const source = vi.fn(async function* () {});
          await expect(engine.build(id, identity, columns, source)).rejects.toThrow("invalid_export_schema");
          expect(query).not.toHaveBeenCalled();
          expect(source).not.toHaveBeenCalled();
          expect(chunks.size).toBe(0);
        },
      );

      it.each([false, true])("publishes the complete unified inventory schema (empty=%s)", async empty => {
        const { engine, identity, id, metadata, chunks } = lifecycle();
        metadata.kind = "unified_agents";
        const columns = inventoryExportColumns.unified_agents;
        await engine.build(id, identity, columns, async function* () {
          if (!empty) yield [{ agentId: "agent:exact", recordType: "source", sourceIdentity: "package",
            sourceDomain: "packages", sourceEvidence: "[]", childKind: null }];
        });
        const csv = Buffer.concat([...chunks.values()].map(chunk => chunk.bytes));
        expect(csv.toString().split("\r\n")[0]).toBe(`\uFEFF${columns.join(",")}`);
        expect(parseCsv(csv, { columns: true, bom: true })).toEqual(empty ? [] : [
          expect.objectContaining({ agentId: "agent:exact", recordType: "source", sourceIdentity: "package",
            sourceDomain: "packages", sourceEvidence: "[]", childKind: "" }),
        ]);
        expect(metadata).toMatchObject({ status: "ready", row_count: empty ? 0 : 1, byte_count: csv.byteLength });
      });

      it.each(["commit", "deadline"] as const)("does not report an export chunk rolled back at its %s boundary", async boundary => {
        if (boundary === "deadline") vi.useFakeTimers();
        const { engine, identity, id, metadata, chunks, query, queryWork } = lifecycle();
        flushDataWorkMetrics();
        let staged = false;
        const primary = new Error("Synthetic chunk commit failure.");
        query.mockImplementation(async (statement: unknown, values?: unknown[]) => {
          if (statement === "COMMIT" && staged && boundary === "commit") throw primary;
          const result = await queryWork(statement, values);
          if (typeof statement === "string" && statement.startsWith("UPDATE data_exports SET row_count")) staged = true;
          if (statement === "ROLLBACK") staged = false;
          return result;
        });
        if (boundary === "deadline") observeTransactionResult(async () => {
          if (staged) vi.setSystemTime(metadata.deadline_at);
          return undefined;
        });
        const build = engine.build(id, identity, ["Name"], async function* () { yield [{ Name: "one" }]; });
        if (boundary === "commit") await expect(build).rejects.toBe(primary);
        else await expect(build).rejects.toThrow("export_deadline");
        expect(chunks.size).toBe(0);
        expect(metadata.status).toBe("failed");
        expect(flushDataWorkMetrics()).toEqual([]);
      });

      it("retains committed export-chunk progress when later producer work fails", async () => {
        const { engine, identity, id, chunks, metadata } = lifecycle();
        flushDataWorkMetrics();
        const primary = new Error("Synthetic producer failure.");
        await expect(engine.build(id, identity, ["Name"], async function* () {
          for (let index = 0; index < 4; index++) yield [{ Name: "x".repeat(300_000) }];
          throw primary;
        })).rejects.toBe(primary);
        expect(chunks.size).toBe(4);
        expect(metadata).toMatchObject({ status: "failed", row_count: 4, byte_count: 1_048_576 });
        expect(flushDataWorkMetrics()).toEqual([{ stage: "export", count: 1, rows: 4, bytes: 1_048_576 }]);
      });

      it.each(["chunk", "ready", "renewal"] as const)("rolls back %s if the checked lease expires before COMMIT", async phase => {
        vi.useFakeTimers();
        const { engine, identity, id, metadata, chunks, query, queryWork, audit } = lifecycle();
        const expires = new Date(Date.now() + 25_000);
        metadata.lease_until = expires;
        let staged = false;
        const prefix = phase === "chunk" ? "UPDATE data_exports SET row_count"
          : phase === "ready" ? "UPDATE data_exports SET status='ready'" : "UPDATE data_exports SET lease_until";
        query.mockImplementation(async (statement: unknown, values?: unknown[]) => {
          const result = await queryWork(statement, values);
          if (typeof statement === "string" && statement.startsWith(prefix)) staged = true;
          return result;
        });
        observeTransactionResult(async () => {
          if (staged) { staged = false; vi.setSystemTime(expires); }
          return undefined;
        });
        const started = Promise.withResolvers<void>();
        const building = engine.build(id, identity, ["Name"], async function* (signal) {
          started.resolve();
          if (phase === "renewal") {
            await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
          }
          yield [{ Name: "one" }];
        });
        const rejected = expect(building).rejects.toThrow("export_fenced");
        await started.promise;
        if (phase === "renewal") await vi.advanceTimersByTimeAsync(20_000);
        await rejected;
        expect(metadata).toMatchObject({ status: "failed", error_code: "export_fenced", lease_until: expires });
        expect(chunks.size).toBe(phase === "ready" ? 1 : 0);
        expect(query).toHaveBeenCalledWith("ROLLBACK");
        await expect(engine.download(id, identity, new AbortController().signal).next()).rejects.toThrow("export_not_ready");
        expect(audit.mock.calls.filter(([, event]) => event.phase === "build").map(([, event]) => event.status))
          .toEqual(phase === "ready" ? ["succeeded", "failed"] : ["failed"]);
      });

      it("rejects creation from a changed inventory association revision before inserting or auditing the job", async () => {
        const { identity, engine, association, query, audit } = inventoryLifecycle();
        association.revision = "2";
        await expect(engine.create(identity, { selectionId: "selection", queryHash: "a".repeat(64),
          kind: "unified_agents", filename: "inventory.csv" })).rejects.toMatchObject({ code: "selection_invalidated" });
        expect(query.mock.calls.some(([statement]) => typeof statement === "string" && statement.startsWith("INSERT INTO data_exports"))).toBe(false);
        expect(audit).not.toHaveBeenCalled();
      });

      it("fences cached inventory source reads and persists selection invalidation as the build failure", async () => {
        const { id, identity, engine, association, metadata, audit } = inventoryLifecycle();
        const staleRead = vi.fn(async () => [{ Name: "must not read" }]);
        await expect(engine.build(id, identity, ["Name"], async function* (_signal, context) {
          yield await context.read(async () => [{ Name: "first" }]);
          association.revision = "2";
          yield await context.read(staleRead);
        })).rejects.toMatchObject({ code: "selection_invalidated" });
        expect(staleRead).not.toHaveBeenCalled();
        expect(metadata).toMatchObject({ status: "failed", error_code: "selection_invalidated" });
        expect(audit).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
          phase: "build", status: "failed", errorCode: "selection_invalidated",
        }));
      });

      it.each(["work", "commit", "cleanup"] as const)("does not release producer rows when its lease expires during %s", async phase => {
        vi.useFakeTimers({ toFake: ["Date"] });
        const { id, identity, engine, metadata, chunks, query, client, queryWork } = lifecycle();
        metadata.deadline_at = metadata.expires_at = new Date(Date.now() + 120_000);
        const leaseUntil = metadata.lease_until = new Date(Date.now() + 1000);
        let readFinished = false, reading = false;
        if (phase === "cleanup") vi.spyOn(client, "query").mockImplementation(async (statement: unknown, values?: unknown[]) => {
          const result = await queryWork(statement, values);
          if (reading && typeof statement === "string" && statement.startsWith("SELECT pg_advisory_unlock")) {
            vi.setSystemTime(leaseUntil);
          }
          return result;
        });
        observeTransactionResult(async () => {
          if (reading && phase === "commit") {
            reading = false;
            vi.setSystemTime(leaseUntil);
          }
          return undefined;
        });
        await expect(engine.build(id, identity, ["Name"], async function* (_signal, context) {
          const rows = await context.read(async () => {
            reading = true;
            if (phase === "work") vi.setSystemTime(leaseUntil);
            return [{ Name: "must not leave the read" }];
          });
          readFinished = true;
          yield rows;
        })).rejects.toThrow("export_fenced");
        expect(readFinished).toBe(false);
        expect(metadata).toMatchObject({ status: "failed", error_code: "export_fenced" });
        expect(chunks.size).toBe(0);
        if (phase !== "cleanup") expect(query).toHaveBeenCalledWith("ROLLBACK");
      });

      it.each((["expiry", "cancellation"] as const).flatMap(interruption =>
        (["fence", "work", "commit", "cleanup"] as const).map(phase => ({ interruption, phase }))))(
        "never releases selected IDs after $interruption during page $phase",
        async ({ interruption, phase }) => {
          vi.useFakeTimers({ toFake: ["Date"] });
          const { id, identity, engine, metadata, chunks, selectedIds, query, queryWork, audit } = lifecycle();
          metadata.selection_mode = "explicit";
          metadata.deadline_at = metadata.expires_at = new Date(Date.now() + 120_000);
          const leaseUntil = metadata.lease_until = new Date(Date.now() + 1000);
          selectedIds.push("must-not-process");
          const parent = new AbortController();
          let selecting = false, pageQueries = 0;
          const interrupt = () => {
            selecting = false;
            if (interruption === "expiry") vi.setSystemTime(leaseUntil);
            else parent.abort(new Error("export_cancelled"));
          };
          query.mockImplementation(async (statement: unknown, values?: unknown[]) => {
            const result = await queryWork(statement, values);
            if (selecting && typeof statement === "string") {
              if (statement.startsWith("SELECT ordinal,identity FROM data_export_items")) {
                pageQueries++;
                if (phase === "work") interrupt();
              }
              if ((phase === "fence" && statement.startsWith("SELECT id FROM data_exports"))
                || (phase === "cleanup" && statement.startsWith("SELECT pg_advisory_unlock"))) interrupt();
            }
            return result;
          });
          observeTransactionResult(async () => {
            if (selecting && phase === "commit") interrupt();
            return undefined;
          });
          const processPage = vi.fn((ids: readonly string[]) => ids.map(Name => ({ Name })));
          const code = interruption === "expiry" ? "export_fenced" : "export_cancelled";
          await expect(engine.build(id, identity, ["Name"], async function* (_signal, context) {
            yield [{ Name: "already buffered" }];
            selecting = true;
            for await (const ids of context.selectedIds()) yield processPage(ids);
          }, parent.signal)).rejects.toThrow(code);
          expect(processPage).not.toHaveBeenCalled();
          expect(pageQueries).toBe(phase === "fence" ? 0 : 1);
          expect(metadata).toMatchObject({ status: interruption === "expiry" ? "failed" : "cancelled", error_code: code, row_count: 0, byte_count: 0, checksum: "" });
          expect(chunks.size).toBe(0);
          if (phase !== "cleanup") expect(query).toHaveBeenCalledWith("ROLLBACK");
          await expect(engine.download(id, identity, new AbortController().signal).next()).rejects.toThrow("export_not_ready");
          expect(audit.mock.calls.filter(([, event]) => event.phase === "build").map(([, event]) => event.status))
            .toEqual([interruption === "expiry" ? "failed" : "cancelled"]);
        },
      );

      it("does not read selected IDs or replace the settlement of a superseding lease", async () => {
        const { id, identity, engine, metadata, chunks, query, audit } = lifecycle();
        const processPage = vi.fn((ids: readonly string[]) => ids.map(Name => ({ Name })));
        await expect(engine.build(id, identity, ["Name"], async function* (_signal, context) {
          metadata.owner = "replacement-owner";
          metadata.lease_version++;
          for await (const ids of context.selectedIds()) yield processPage(ids);
        })).rejects.toThrow("export_fenced");
        expect(query.mock.calls.some(([statement]) => typeof statement === "string"
          && statement.startsWith("SELECT ordinal,identity FROM data_export_items"))).toBe(false);
        expect(processPage).not.toHaveBeenCalled();
        expect(metadata).toMatchObject({ owner: "replacement-owner", lease_version: 2, status: "building", error_code: null });
        expect(chunks.size).toBe(0);
        expect(audit).not.toHaveBeenCalled();
      });

      it.each([0, 251])("preserves bounded selected-ID pages and explicit header-only output for %s IDs", async count => {
        const { id, identity, engine, metadata, chunks, selectedIds, query } = lifecycle();
        metadata.selection_mode = "explicit";
        selectedIds.push(...Array.from({ length: count }, (_, index) => `selected-${index}`));
        const pages: number[] = [];
        await engine.build(id, identity, ["Name"], async function* (_signal, context) {
          for await (const ids of context.selectedIds()) {
            pages.push(ids.length);
            yield ids.map(Name => ({ Name }));
          }
        });
        expect(pages).toEqual(count ? [250, 1] : []);
        const csv = Buffer.concat([...chunks.values()].map(chunk => chunk.bytes));
        if (!count) expect(csv.toString()).toBe("\uFEFFName\r\n");
        expect(parseCsv(csv, { columns: true, bom: true })).toEqual(selectedIds.map(Name => ({ Name })));
        expect(metadata).toMatchObject({ status: "ready", row_count: count });
        expect(query).toHaveBeenCalledWith("BEGIN ISOLATION LEVEL REPEATABLE READ");
        expect(query).toHaveBeenCalledWith("SELECT pg_advisory_lock(hashtextextended($1,149))", [id]);
      });

      it("fails selected-ID serialization conflicts without processing, publishing or replaying the page", async () => {
        const { id, identity, engine, metadata, chunks, query, queryWork, audit } = lifecycle();
        const conflict = Object.assign(new Error("synthetic selected-ID conflict"), { code: "40001" });
        let pageQueries = 0;
        query.mockImplementation(async (statement: unknown, values?: unknown[]) => {
          if (typeof statement === "string" && statement.startsWith("SELECT ordinal,identity FROM data_export_items")) {
            pageQueries++;
            throw conflict;
          }
          return queryWork(statement, values);
        });
        const processPage = vi.fn((ids: readonly string[]) => ids.map(Name => ({ Name })));
        await expect(engine.build(id, identity, ["Name"], async function* (_signal, context) {
          for await (const ids of context.selectedIds()) yield processPage(ids);
        })).rejects.toMatchObject({ code: "data_read_conflict", cause: conflict });
        expect(pageQueries).toBe(1);
        expect(processPage).not.toHaveBeenCalled();
        expect(chunks.size).toBe(0);
        expect(metadata).toMatchObject({ status: "failed", error_code: "data_read_conflict" });
        expect(audit).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
          phase: "build", status: "failed", errorCode: "data_read_conflict",
        }));
      });

      it("rejects a reviewed-association change after the inventory producer finishes but before publication", async () => {
        const { id, identity, engine, association, metadata } = inventoryLifecycle();
        await expect(engine.build(id, identity, ["Name"], async function* () {
          yield [{ Name: "one" }];
          association.revision = "2";
        })).rejects.toMatchObject({ code: "selection_invalidated" });
        expect(metadata.status).toBe("failed");
      });

      it("revokes ready inventory status and the next download chunk after a reviewed-association change", async () => {
        const { id, identity, engine, association, audit, build } = inventoryLifecycle();
        await build("x".repeat(300_000));
        const iterator = engine.download(id, identity, new AbortController().signal);
        expect((await iterator.next()).value?.length).toBe(262_144);
        association.revision = "2";
        await expect(engine.status(id, identity)).rejects.toMatchObject({ code: "selection_invalidated" });
        await expect(iterator.next()).rejects.toMatchObject({ code: "selection_invalidated" });
        expect(audit).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
          phase: "download", status: "failed", bytes: 262_144,
        }));
      });

      it("does not yield a chunk whose artifact expires during the awaited read", async () => {
        const { id, identity, engine, metadata, client, queryWork, audit, build } = lifecycle();
        await build("must not download after expiry");
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.spyOn(client, "query").mockImplementation(async (statement: unknown, values?: unknown[]) => {
          const result = await queryWork(statement, values);
          if (typeof statement === "string" && statement.startsWith("SELECT bytes,byte_count,checksum")) {
            vi.setSystemTime(metadata.expires_at);
          }
          return result;
        });
        await expect(engine.download(id, identity, new AbortController().signal).next()).rejects.toThrow("export_expired");
        expect(audit).toHaveBeenLastCalledWith(client, expect.objectContaining({
          phase: "download", status: "failed", bytes: 0,
        }));
      });

      it("keeps a safe selection-invalidated code instead of its descriptive error message", async () => {
        const { id, identity, engine, metadata } = lifecycle();
        await expect(engine.build(id, identity, ["Name"], async function* () {
          throw new AppError(409, "selection_invalidated", "The captured source is no longer current.");
        })).rejects.toMatchObject({ code: "selection_invalidated" });
        expect(metadata).toMatchObject({ status: "failed", error_code: "selection_invalidated" });
      });

      it("fences a persisted query mismatch before a producer read and never publishes its buffered rows", async () => {
        const { id, identity, engine, metadata, chunks } = lifecycle();
        const read = vi.fn(async () => [{ Name: "must not read" }]);
        await expect(engine.build(id, identity, ["Name"], async function* (_signal, context) {
          yield [{ Name: "buffered" }];
          metadata.query_hash = "b".repeat(64);
          yield await context.read(read);
        })).rejects.toMatchObject({ code: "export_selection_changed" });
        expect(read).not.toHaveBeenCalled();
        expect(chunks.size).toBe(0);
        expect(metadata).toMatchObject({ status: "failed", error_code: "export_selection_changed" });
      });

      it("rejects ready status and the next download chunk after its persisted query binding changes", async () => {
        const { id, identity, engine, metadata, build, audit } = lifecycle();
        await build("x".repeat(300_000));
        const iterator = engine.download(id, identity, new AbortController().signal);
        expect((await iterator.next()).value?.length).toBe(262_144);
        metadata.query_hash = "b".repeat(64);
        await expect(engine.status(id, identity)).rejects.toMatchObject({ code: "export_selection_changed" });
        await expect(iterator.next()).rejects.toMatchObject({ code: "export_selection_changed" });
        expect(audit).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ status: "failed", bytes: 262_144 }));
      });

      it("settles dispatcher work without an unhandled rejection when failure auditing fails", async () => {
        const { id, identity, database } = lifecycle();
        const reports = new LargeTenantUsersReports(database, "synthetic-durable-dispatcher-test-secret", 35);
        vi.spyOn(reports.sources.connections, "run").mockResolvedValue({});
        vi.spyOn(OfficialReportImports.prototype, "sweep").mockResolvedValue(0);
        vi.mocked(database.query).mockImplementation(async statement => ({ command: "SELECT", oid: 0, fields: [], rowCount: 1,
          rows: String(statement).includes("FROM operational_state") ? [{
            mode: "normal",
          }] : [{
            id, kind: "official_users", tenant_id: identity.tenantId, principal_id: identity.principalId,
            authorization_hash: identity.authorizationHash, session_epoch: identity.sessionEpoch,
            actor: { tenantId: identity.tenantId, homeAccountId: identity.principalId, username: "exporter@example.invalid", displayName: "Exporter" },
          }] }));
        vi.spyOn(DataExports.prototype, "expire").mockResolvedValue(0);
        vi.spyOn(OfficialReportExports.prototype, "status").mockRejectedValue(new AppError(409, "selection_invalidated", "Selection retired."));
        const settle = vi.spyOn(DataExports.prototype, "failPending").mockRejectedValue(new Error("synthetic audit write failure"));
        const dispatcher = new ReportExportDispatcher(reports);
        withAuthority(exportAuthority(identity), () => dispatcher.enqueue(id, identity, false));
        dispatcher.wake();
        await vi.waitFor(() => expect(settle).toHaveBeenCalledWith(id, "selection_invalidated"));
        await expect(dispatcher.drain()).resolves.toBeUndefined();
        expect(operationalLog).toHaveBeenCalledWith("error", "report_export_settlement_failed",
          { errorCode: "internal_error", errorKind: "unexpected", jobId: id });
        expect(operationalLog).toHaveBeenCalledWith("warn", "report_export_work_failed",
          { errorCode: "selection_invalidated", errorKind: "application", status: 409, jobId: id });
      });

      it("publishes a zero-row BOM/header artifact and does not overwrite its completed build when cancelled", async () => {
        const { id, identity, engine, audit, build } = lifecycle();
        await build();
        const received: Buffer[] = [];
        for await (const chunk of engine.download(id, identity, new AbortController().signal)) received.push(chunk);
        expect(Buffer.concat(received).toString()).toBe("\uFEFFName\r\n");
        await engine.cancel(id, identity);
        await engine.cancel(id, identity);
        expect(await engine.status(id, identity)).toMatchObject({ status: "cancelled" });
        expect(audit.mock.calls.map(([, event]) => [event.phase, event.status]))
          .toEqual([["build", "succeeded"], ["download", "started"], ["download", "succeeded"], ["cancel", "started"], ["cancel", "succeeded"]]);
      });

      it.each(["build", "download"] as const)("rejects extra persisted chunks during %s instead of ignoring them", async phase => {
        const { id, identity, engine, chunks, metadata, audit, build } = lifecycle();
        const extra = Buffer.from("extra");
        const poison = () => chunks.set(7, { bytes: extra, byte_count: extra.length, checksum: createHash("sha256").update(extra).digest("hex") });
        if (phase === "build") {
          await expect(engine.build(id, identity, ["Name"], async function* () {
            poison(); yield [{ Name: "one" }];
          })).rejects.toThrow("export_checksum");
          expect(metadata.status).toBe("failed");
        } else {
          await build("one"); poison();
          await expect(engine.download(id, identity, new AbortController().signal).next()).rejects.toThrow("export_checksum");
        }
        expect(audit).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ phase, status: "failed" }));
      });

      it.each(["missing", "bytes", "byte-count", "metadata"] as const)("never releases a %s-corrupt chunk", async corruption => {
        const { id, identity, engine, chunks, metadata, build, audit } = lifecycle();
        await build("one");
        const chunk = chunks.get(0)!;
        if (corruption === "missing") chunks.clear();
        if (corruption === "bytes") chunk.bytes = Buffer.from("corrupt");
        if (corruption === "byte-count") chunk.byte_count++;
        if (corruption === "metadata") metadata.chunk_count = 0;
        await expect(engine.download(id, identity, new AbortController().signal).next()).rejects.toThrow("export_checksum");
        expect(audit).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ phase: "download", status: "failed", bytes: 0 }));
      });

      it("cancels an idle producer once and prevents its failure handler from replacing the cancellation", async () => {
        const { id, identity, engine, database, selections, metadata, audit } = lifecycle();
        const started = Promise.withResolvers<void>();
        const building = engine.build(id, identity, ["Name"], async function* (signal) {
          started.resolve();
          await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
          yield [{ Name: "unreachable" }];
        });
        const rejected = expect(building).rejects.toThrow("export_cancelled");
        await started.promise;
        const requestEngine = new DataExports(database, selections, audit);
        await requestEngine.cancel(id, identity);
        await rejected;
        await engine.cancel(id, identity);
        expect(metadata.status).toBe("cancelled");
        expect(audit.mock.calls.filter(([, event]) => event.phase === "build").map(([, event]) => event.status)).toEqual(["cancelled"]);
        expect(audit.mock.calls.filter(([, event]) => event.phase === "cancel").map(([, event]) => event.status)).toEqual(["started", "succeeded"]);
      });

      it("does not start a producer cancelled between lease admission and local signal registration", async () => {
        const { id, identity, engine, database, selections, metadata, audit } = lifecycle();
        const requestEngine = new DataExports(database, selections, audit);
        const run = engine.connections.run.bind(engine.connections);
        let admitted = false;
        vi.spyOn(engine.connections, "run").mockImplementation(async (...args) => {
          const result = await run(...args);
          if (!admitted && metadata.status === "building") {
            admitted = true;
            await requestEngine.cancel(id, identity);
          }
          return result;
        });
        const source = vi.fn(async function* () {
          yield [{ Name: "must not start" }];
        });

        await expect(engine.build(id, identity, ["Name"], source)).rejects.toThrow("export_fenced");
        expect(source).not.toHaveBeenCalled();
        expect(metadata.status).toBe("cancelled");
        expect(audit.mock.calls.filter(([, event]) => event.phase === "build").map(([, event]) => event.status)).toEqual(["cancelled"]);
        expect(audit.mock.calls.filter(([, event]) => event.phase === "cancel").map(([, event]) => event.status)).toEqual(["started", "succeeded"]);
      });

      it("records failed completion when the native transport cannot finish the final payload", async () => {
        const { id, identity, engine, build, audit } = lifecycle();
        await build("one");
        const primary = new Error("synthetic transport failure");
        const publication = { validate: vi.fn(async () => () => {}),
          finish: vi.fn(async () => { throw primary; }), failed: vi.fn() };
        const iterator = engine.download(id, identity, new AbortController().signal, publication);
        expect((await iterator.next()).value?.toString()).toBe("\uFEFFName\r\n\"one\"\r\n");
        await expect(iterator.next()).rejects.toBe(primary);
        expect(publication.finish).toHaveBeenCalledOnce();
        expect(publication.failed).toHaveBeenCalledOnce();
        expect(audit.mock.calls.filter(([, event]) => event.phase === "download").map(([, event]) => event.status))
          .toEqual(["started", "inconclusive", "failed"]);
      });

      it("never leaves a successful receipt when both transport finish and failure auditing reject", async () => {
        const { id, identity, engine, build, audit } = lifecycle();
        await build("one");
        const primary = new Error("synthetic transport failure");
        const persisted: Parameters<ExportAudit>[1][] = [];
        audit.mockImplementation(async (_client, event) => {
          if (event.status === "failed") throw new Error("synthetic failure audit rejection");
          persisted.push(event);
        });
        const publication = { validate: async () => () => {}, finish: vi.fn(async () => { throw primary; }), failed: vi.fn() };
        const iterator = engine.download(id, identity, new AbortController().signal, publication);
        await iterator.next();
        await expect(iterator.next()).rejects.toBe(primary);
        expect(persisted.map(event => event.status)).toEqual(["started", "inconclusive"]);
        expect(publication.failed).toHaveBeenCalledOnce();
      });

      it("withholds transport finish when the verified audit gate cannot commit", async () => {
        const { id, identity, engine, build, audit, query } = lifecycle();
        await build("one");
        const primary = new Error("synthetic verified audit rejection");
        audit.mockImplementation(async (_client, event) => { if (event.status === "inconclusive") throw primary; });
        const publication = { validate: async () => () => {}, finish: vi.fn(async () => {}), failed: vi.fn() };
        const iterator = engine.download(id, identity, new AbortController().signal, publication);
        await iterator.next();
        await expect(iterator.next()).rejects.toBe(primary);
        expect(publication.finish).not.toHaveBeenCalled();
        expect(query).toHaveBeenCalledWith("ROLLBACK");
        expect(audit).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ phase: "download", status: "failed" }));
      });

      it("does not relabel an acknowledged transport finish when terminal audit fails or its selection expires", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        const { id, identity, engine, metadata, build, audit, selections } = lifecycle();
        await build("one");
        audit.mockImplementation(async (_client, event) => {
          if (event.phase === "download" && event.status === "succeeded") throw new Error("synthetic terminal audit rejection");
        });
        const publication = { validate: async () => () => {}, failed: vi.fn(),
          finish: vi.fn(async () => {
            vi.setSystemTime(metadata.expires_at);
            vi.mocked(selections.assert).mockRejectedValue(new AppError(409, "selection_invalidated", "Selection retired after finish."));
          }) };
        const iterator = engine.download(id, identity, new AbortController().signal, publication);
        await iterator.next();
        await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
        expect(publication.failed).not.toHaveBeenCalled();
        expect(audit.mock.calls.filter(([, event]) => event.phase === "download").map(([, event]) => event.status))
          .toEqual(["started", "inconclusive", "succeeded"]);
        expect(operationalLog).toHaveBeenCalledWith("error", "export_audit_completion_failed",
          { errorCode: "audit_completion_failed", errorKind: "unexpected", jobId: id });
      });

      it("records success only after finish with its observed timestamp, not the later audit time", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        const { id, identity, engine, build, audit } = lifecycle();
        await build("one");
        const finishedAt = new Date().toISOString();
        const publication = { validate: async () => () => {}, failed: vi.fn(),
          finish: vi.fn(async () => {
            expect(audit.mock.calls.filter(([, event]) => event.phase === "download").map(([, event]) => event.status))
              .toEqual(["started", "inconclusive"]);
            vi.setSystemTime(Date.now() + 1000);
            return finishedAt;
          }) };
        const iterator = engine.download(id, identity, new AbortController().signal, publication);
        await iterator.next();
        await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
        expect(audit).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
          phase: "download", status: "succeeded", completedAt: finishedAt,
        }));
        expect(publication.failed).not.toHaveBeenCalled();
      });

      it.each(["build", "download"] as const)("preserves acknowledged %s success after connection release fails", async phase => {
        const { id, identity, engine, client, metadata, build, audit, query } = lifecycle();
        const cleanup = new Error("synthetic post-COMMIT release failure");
        audit.mockImplementation(async (_client, event) => {
          if (event.phase === phase && event.status === "succeeded") client.release.mockImplementationOnce(() => { throw cleanup; });
        });
        await expect(build("one")).resolves.toBeUndefined();
        if (phase === "download") {
          const iterator = engine.download(id, identity, new AbortController().signal);
          await iterator.next();
          await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
        }
        expect(metadata.status).toBe("ready");
        expect(audit.mock.calls.filter(([, event]) => event.phase === phase).map(([, event]) => event.status))
          .toEqual(phase === "build" ? ["succeeded"] : ["started", "succeeded"]);
        expect(query).not.toHaveBeenCalledWith("ROLLBACK");
        expect(operationalLog).toHaveBeenCalledWith("error", "export_post_commit_cleanup_failed",
          { errorCode: "internal_error", errorKind: "unexpected", jobId: id });
      });

      it("returns the committed creation identity despite failed connection release", async () => {
        const { identity, engine, client, query, audit } = lifecycle();
        client.release.mockImplementationOnce(() => { throw new Error("synthetic creation release failure"); });
        const id = await engine.create(identity, { selectionId: "selection", queryHash: "a".repeat(64),
          kind: "official_users", filename: "users.csv" });
        expect(audit).toHaveBeenCalledWith(client, expect.objectContaining({ id, exportId: id, status: "started" }));
        expect(query).toHaveBeenCalledWith("COMMIT");
        expect(query).not.toHaveBeenCalledWith("ROLLBACK");
      });

      it("snapshots only actor identity fields before awaited export admission", async () => {
        const { identity, engine, query, queryWork } = lifecycle();
        const original = { tenantId: identity.tenantId, homeAccountId: identity.principalId,
          username: "original@example.invalid", displayName: "Original" };
        const actor = { ...original, roles: ["private-role"] };
        query.mockImplementation(async (statement: unknown, values?: unknown[]) => {
          if (statement === "SELECT pg_advisory_xact_lock(3650148)") actor.username = "changed@example.invalid";
          return queryWork(statement, values);
        });
        await engine.create(identity, { selectionId: "selection", queryHash: "a".repeat(64),
          kind: "official_users", filename: "users.csv", actor });
        const insert = query.mock.calls.find(([statement]) => typeof statement === "string" && statement.startsWith("INSERT INTO data_exports"));
        expect(JSON.parse(String(insert?.[1]?.[9]))).toEqual(original);
      });

      it("stops the owned producer after committed cancellation even if connection release fails", async () => {
        const { id, identity, engine, client, metadata, audit } = lifecycle();
        const entered = Promise.withResolvers<void>();
        const building = engine.build(id, identity, ["Name"], async function* (signal) {
          entered.resolve();
          await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
        });
        const rejected = expect(building).rejects.toThrow("export_cancelled");
        await entered.promise;
        client.release.mockImplementationOnce(() => { throw new Error("synthetic cancellation release failure"); });
        await expect(engine.cancel(id, identity)).resolves.toBeUndefined();
        await rejected;
        expect(metadata.status).toBe("cancelled");
        expect(audit.mock.calls.filter(([, event]) => event.phase === "build").map(([, event]) => event.status)).toEqual(["cancelled"]);
        expect(audit.mock.calls.filter(([, event]) => event.phase === "cancel").map(([, event]) => event.status)).toEqual(["started", "succeeded"]);
      });

      it("settles an admitted download start when post-COMMIT cleanup fails before the first yield", async () => {
        const { id, identity, engine, client, build, audit } = lifecycle();
        await build("one");
        const primary = new Error("synthetic download admission release failure");
        client.release.mockImplementationOnce(() => { throw primary; });
        await expect(engine.download(id, identity, new AbortController().signal).next()).rejects.toBe(primary);
        expect(audit.mock.calls.filter(([, event]) => event.phase === "download").map(([, event]) => event.status))
          .toEqual(["started", "failed"]);
        expect(audit).toHaveBeenLastCalledWith(client, expect.objectContaining({ phase: "download", status: "failed", bytes: 0 }));
      });

      it.each([null, undefined])("preserves exact thrown %s when failure auditing also rejects", async primary => {
        const { id, identity, engine, build, audit } = lifecycle();
        await build("one");
        const iterator = engine.download(id, identity, new AbortController().signal);
        await iterator.next();
        audit.mockRejectedValue(new Error("synthetic failure audit rejection"));
        await expect(iterator.throw(primary)).rejects.toBe(primary);
      });

      it.each(["deadline", "cancellation"] as const)("classifies signal %s without losing its exact reason", async outcome => {
        const { id, identity, engine, build, audit } = lifecycle();
        await build("one");
        const controller = new AbortController();
        const iterator = engine.download(id, identity, controller.signal);
        await iterator.next();
        const primary = outcome === "deadline" ? new AppError(409, "export_expired", "Expired.") : null;
        controller.abort(primary);
        await expect(iterator.next()).rejects.toBe(primary);
        expect(audit).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
          phase: "download", status: outcome === "deadline" ? "failed" : "cancelled",
          errorCode: outcome === "deadline" ? "export_expired" : "export_download_cancelled",
        }));
      });

      it("classifies an early iterator return as cancelled without claiming transport delivery", async () => {
        const { id, identity, engine, build, audit } = lifecycle();
        await build("one");
        const iterator = engine.download(id, identity, new AbortController().signal);
        await iterator.next();
        await iterator.return(undefined);
        expect(audit).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
          phase: "download", status: "cancelled", errorCode: "export_download_cancelled",
        }));
      });

      it("keeps exact allowlisted authority failure codes and omits arbitrary error evidence", async () => {
        const { id, identity, engine, build, audit } = lifecycle();
        await build("one");
        const iterator = engine.download(id, identity, new AbortController().signal);
        await iterator.next();
        const primary = new AppError(500, "synthetic private SQL and username", "private response", { rows: ["private row"] });
        await expect(iterator.throw(primary)).rejects.toBe(primary);
        expect(audit).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
          phase: "download", status: "failed", errorCode: "export_download_failed",
        }));
        expect(JSON.stringify(audit.mock.calls.map(([, event]) => event))).not.toContain("private");
      });

      it("rejects an overdue publication before COMMIT even when its deadline timer has not run", async () => {
        vi.useFakeTimers();
        const { metadata, build } = lifecycle();
        observeTransactionResult(async () => {
          if (metadata.status === "ready") vi.setSystemTime(metadata.deadline_at);
          return undefined;
        });
        await expect(build("one")).rejects.toThrow("export_deadline");
        expect(metadata).toMatchObject({ status: "failed", error_code: "export_deadline" });
      });

      it("fences admitted creation immediately before COMMIT after the awaited audit", async () => {
        const { identity, engine, query, audit } = lifecycle();
        let current = true;
        const primary = AppError.unauthorized();
        const assertCurrent = () => { if (!current) throw primary; };
        audit.mockImplementation(async () => { current = false; });
        await expect(engine.create(identity, { selectionId: "selection", queryHash: "a".repeat(64),
          kind: "official_users", filename: "users.csv" }, assertCurrent)).rejects.toBe(primary);
        expect(query).toHaveBeenCalledWith("ROLLBACK");
        expect(query).not.toHaveBeenCalledWith("COMMIT");
      });

      it("does not commit cancellation from a superseded request", async () => {
        const { id, identity, engine, audit, metadata } = lifecycle();
        let current = true;
        const primary = AppError.unauthorized();
        const assertCurrent = () => { if (!current) throw primary; };
        audit.mockImplementation(async () => { current = false; });
        await expect(engine.cancel(id, identity, assertCurrent)).rejects.toBe(primary);
        expect(metadata.status).toBe("queued");
      });

      it("preserves the producer failure when its transactional settlement audit also rejects", async () => {
        const { id, identity, engine, audit, metadata } = lifecycle();
        const primary = new AppError(413, "data_batch_bytes", "data_batch_bytes", { limit: 1_048_576, observed: 1_048_577 });
        audit.mockRejectedValue(new Error("synthetic settlement audit failure"));
        await expect(engine.build(id, identity, ["Name"], async function* () { throw primary; })).rejects.toBe(primary);
        expect(metadata.status).toBe("building");
        expect(audit).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ status: "failed", errorCode: "data_batch_bytes" }));
      });

      it("preserves partial-stream authority failure even when failure auditing also rejects", async () => {
        const { id, identity, engine, build, selections, audit } = lifecycle();
        await build("x".repeat(300_000));
        const iterator = engine.download(id, identity, new AbortController().signal);
        expect((await iterator.next()).value?.length).toBe(262_144);
        const primary = new AppError(409, "selection_invalidated", "Selection retired.");
        vi.mocked(selections.assert).mockRejectedValue(primary);
        audit.mockImplementation(async (_client, event) => {
          if (event.status === "failed") throw new Error("synthetic SQL audit failure");
        });
        await expect(iterator.next()).rejects.toBe(primary);
        expect(audit).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ status: "failed", bytes: 262_144 }));
        expect(operationalLog).toHaveBeenLastCalledWith("error", "export_audit_completion_failed",
          { errorCode: "audit_completion_failed", errorKind: "unexpected" });
      });

      it("corrects download completion after post-commit authority loss without releasing the final transport payload", async () => {
        const { id, identity, engine, build, audit } = lifecycle();
        await build("one");
        let current = true, verified = false;
        const primary = AppError.unauthorized();
        const assertCurrent = () => { if (!current) throw primary; };
        audit.mockImplementation(async (_client, event) => { if (event.phase === "download" && event.status === "inconclusive") verified = true; });
        observeTransactionResult(async () => verified ? () => { current = false; } : undefined);
        const publication = { validate: vi.fn(async () => { assertCurrent(); return assertCurrent; }),
          finish: vi.fn(async () => undefined), failed: vi.fn() };
        const iterator = engine.download(id, identity, new AbortController().signal, publication);
        await iterator.next();
        await expect(iterator.next()).rejects.toBe(primary);
        expect(publication.finish).not.toHaveBeenCalled();
        expect(publication.failed).toHaveBeenCalledOnce();
        expect(audit.mock.calls.filter(([, event]) => event.phase === "download").map(([, event]) => event.status))
          .toEqual(["started", "inconclusive", "failed"]);
      });
    });
