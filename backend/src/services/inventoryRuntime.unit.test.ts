import { randomUUID } from "node:crypto";
import { getEventListeners } from "node:events";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataGenerations, type BeginGeneration, type GenerationLease } from "../db/dataGenerations.js";
import { InventoryGenerations } from "../db/inventoryGenerations.js";
import { JobRepository } from "../db/jobs.js";
import type { DataSyncSourceState } from "../types/dataSync.js";
import { completeInventoryJob } from "./inventoryRuntime.js";
import { powerPlatformInventoryRecord } from "./inventoryRecordProjection.js";
import { StreamedInventory } from "./streamedInventory.js";
import { AppError } from "../errors.js";
import { observePublicationWork, observeTransactionResult } from "./peakMemory.js";

vi.mock("../db/pool.js", () => ({
  pool: {},
  secretValue: vi.fn((name: string) => name === "SESSION_SECRET" ? "synthetic-inventory-completion-session-secret" : undefined),
  transaction: vi.fn(async () => { throw new Error("Unit tests must not access a database."); }),
}));

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("inventory child completion", () => {
  it.each((["packages", "power_platform"] as const).flatMap(domain => [
    { domain, sibling: "partial", status: "partial", terminal: true },
    { domain, sibling: "failed", status: "partial", terminal: true },
    { domain, sibling: "waiting_authorization", status: "waiting", terminal: false },
    { domain, sibling: "running", status: "running", terminal: false },
    { domain, sibling: "succeeded", status: "completed", terminal: true },
  ] satisfies { domain: "packages" | "power_platform"; sibling: DataSyncSourceState; status: string; terminal: boolean }[]))(
    "finalizes $domain publication with a $sibling sibling as $status", async ({ domain, sibling, status, terminal }) => {
      const input: BeginGeneration = {
        scope: { kind: "principal", tenantId: "synthetic-completion-tenant", principalId: "synthetic-reader",
          tokenMode: "delegated", source: `inventory_${domain}`, selector: "complete" },
        schemaVersion: 1, sessionEpoch: "0", runId: randomUUID(), jobId: randomUUID(),
        jobKind: domain === "packages" ? "package_refresh" : "power_platform_refresh",
        observedAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
        deadlineAt: new Date(Date.now() + 60_000), reserveBytes: 1024,
      };
      const client = Object.assign(new pg.Client(), { release: vi.fn() });
      const updated: pg.QueryResult = { command: "UPDATE", rows: [], rowCount: 1, fields: [], oid: 0 };
      const query = vi.spyOn(client, "query")
        .mockImplementationOnce(async () => updated)
        .mockImplementationOnce(async () => updated)
        .mockImplementationOnce(async () => updated)
        .mockImplementationOnce(async () => ({ ...updated, command: "SELECT", rows: [{ status: "succeeded" }, { status: sibling }], rowCount: 2 }))
        .mockImplementationOnce(async () => updated);
      await completeInventoryJob(input, domain)(client, { jobId: input.jobId!, rows: 0 });
      expect(query.mock.calls.at(-1)?.[1]).toEqual([
        input.runId, input.scope.tenantId, input.scope.principalId, status, terminal,
      ]);
    },
  );

  it.each(["packages", "power_platform"] as const)("fences %s publication when its parent sync run has expired", async domain => {
    const input: BeginGeneration = {
      scope: { kind: "principal", tenantId: "synthetic-expired-sync", principalId: "synthetic-reader",
        tokenMode: "delegated", source: `inventory_${domain}`, selector: "complete" },
      schemaVersion: 1, sessionEpoch: "0", runId: randomUUID(), jobId: randomUUID(),
      jobKind: domain === "packages" ? "package_refresh" : "power_platform_refresh",
      observedAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
      deadlineAt: new Date(Date.now() + 60_000), reserveBytes: 1024,
    };
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    const updated: pg.QueryResult = { command: "UPDATE", rows: [], rowCount: 1, fields: [], oid: 0 };
    const query = vi.spyOn(client, "query")
      .mockImplementationOnce(async () => updated)
      .mockImplementationOnce(async sql => {
        if (typeof sql !== "string") throw new Error("Unexpected query shape.");
        return { ...updated, rowCount: sql.includes("r.expires_at>clock_timestamp()") ? 0 : 1 };
      });

    await expect(completeInventoryJob(input, domain)(client, { jobId: input.jobId!, rows: 2 }))
      .rejects.toMatchObject({ code: "inventory_run_fenced" });
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe("inventory durable commit notification", () => {
  it.each(["success", "release", "measurement", "publication_observer", "commit_notification"] as const)(
    "stops the managed heartbeat without rewriting commit ownership after %s", async stage => {
      vi.useFakeTimers();
      const database = new pg.Pool({ max: 4 });
      const failure = new Error("Synthetic post-commit cleanup failure.");
      const client = Object.assign(new pg.Client(), { release: vi.fn(() => {
        if (stage === "release") throw failure;
      }) });
      vi.spyOn(database, "connect").mockImplementation(async () => client);
      const query = vi.spyOn(client, "query").mockImplementation(async sql => {
        const statement = String(sql);
        const rows = statement.startsWith("SELECT generation_id") ? [{ generation_id: null }]
          : statement.startsWith("UPDATE data_generation_heads") ? [{ revision: "1" }] : [];
        return { command: statement.split(" ")[0], rows, rowCount: rows.length, fields: [], oid: 0 };
      });
      const generations = new DataGenerations(database);
      const lease: GenerationLease = { id: randomUUID(), scopeId: randomUUID(), tenantId: "tenant",
        owner: "owner", version: 1, epoch: "0", sessionEpoch: "0", expectedRevision: "0", schemaVersion: 1 };
      vi.spyOn(generations, "fence").mockResolvedValue({
        job_kind: "power_platform_refresh", job_id: randomUUID(), run_id: null,
        row_count: 0, byte_count: "0", state: "validating", validated: true,
      });
      vi.spyOn(generations, "begin").mockResolvedValue(lease);
      const renew = vi.spyOn(generations, "renew").mockResolvedValue(undefined);
      const abort = vi.spyOn(generations, "abort").mockResolvedValue(undefined);
      const completeJob = vi.fn(async () => {});
      const onCommitted = vi.fn(() => {
        if (stage === "commit_notification") throw failure;
      });
      const parent = new AbortController();
      let heartbeatSignal!: AbortSignal;
      const removeMeasurement = stage === "measurement" ? observeTransactionResult(async () => () => { throw failure; }) : () => {};
      const removePublication = stage === "publication_observer" ? observePublicationWork(() => { throw failure; }) : () => {};
      try {
        const execution = generations.execute({
          scope: { tenantId: lease.tenantId, principalId: "principal", kind: "principal", tokenMode: "delegated",
            source: "inventory_power_platform", selector: "complete" },
          schemaVersion: 1, sessionEpoch: "0", jobKind: "power_platform_refresh", jobId: "job",
          observedAt: new Date(), expiresAt: new Date(Date.now() + 60_000), deadlineAt: new Date(Date.now() + 60_000), reserveBytes: 1024,
        }, (ownedLease, signal) => {
          heartbeatSignal = signal;
          expect(getEventListeners(parent.signal, "abort")).toHaveLength(1);
          expect(vi.getTimerCount()).toBe(1);
          return generations.publish(ownedLease, { completeJob, onCommitted });
        }, parent.signal);
        if (stage === "success") await expect(execution).resolves.toBe("1");
        else await expect(execution).rejects.toBe(failure);
      } finally { removeMeasurement(); removePublication(); }
      expect(completeJob).toHaveBeenCalledOnce();
      expect(onCommitted).toHaveBeenCalledOnce();
      expect(abort).not.toHaveBeenCalled();
      expect(query).toHaveBeenCalledWith("COMMIT");
      expect(query).not.toHaveBeenCalledWith("ROLLBACK");
      expect(client.release).toHaveBeenCalledOnce();
      expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
      expect(getEventListeners(heartbeatSignal, "abort")).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
      parent.abort(new Error("Synthetic cancellation after publication settlement."));
      expect(heartbeatSignal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(renew).not.toHaveBeenCalled();
      expect(abort).not.toHaveBeenCalled();
    },
  );

  it.each(["reject", "rollback"])(
    "fences the unpublished generation and stops its heartbeat when COMMIT settles as %s", async settlement => {
      vi.useFakeTimers();
      const database = new pg.Pool({ max: 4 });
      const client = Object.assign(new pg.Client(), { release: vi.fn() });
      vi.spyOn(database, "connect").mockImplementation(async () => client);
      const query = vi.spyOn(client, "query").mockImplementation(async sql => {
        const statement = String(sql);
        if (statement === "COMMIT" && settlement === "reject") throw new Error("Synthetic COMMIT rejection.");
        const rows = statement.startsWith("SELECT generation_id") ? [{ generation_id: null }]
          : statement.startsWith("UPDATE data_generation_heads") ? [{ revision: "1" }] : [];
        return { command: statement === "COMMIT" ? "ROLLBACK" : statement.split(" ")[0], rows,
          rowCount: rows.length, fields: [], oid: 0 };
      });
      const generations = new DataGenerations(database);
      vi.spyOn(generations, "fence").mockResolvedValue({ job_kind: "fixture", job_id: "job", row_count: 0,
        byte_count: "0", state: "validating", validated: true });
      const lease: GenerationLease = { id: randomUUID(), scopeId: randomUUID(), tenantId: "tenant",
        owner: "owner", version: 1, epoch: "0", sessionEpoch: "0", expectedRevision: "0", schemaVersion: 1 };
      vi.spyOn(generations, "begin").mockResolvedValue(lease);
      const abort = vi.spyOn(generations, "abort").mockResolvedValue(undefined);
      const parent = new AbortController();
      const onCommitted = vi.fn();
      await expect(generations.execute({
        scope: { tenantId: lease.tenantId, principalId: "principal", kind: "principal", tokenMode: "delegated",
          source: "inventory_power_platform", selector: "complete" },
        schemaVersion: 1, sessionEpoch: "0", jobKind: "fixture", jobId: "job",
        observedAt: new Date(), expiresAt: new Date(Date.now() + 60_000), deadlineAt: new Date(Date.now() + 60_000), reserveBytes: 1024,
      }, ownedLease => generations.publish(ownedLease, { onCommitted }), parent.signal)).rejects.toBeInstanceOf(Error);
      expect(onCommitted).not.toHaveBeenCalled();
      expect(abort).toHaveBeenCalledExactlyOnceWith(lease, false);
      expect(query).toHaveBeenCalledWith("ROLLBACK");
      expect(client.release).toHaveBeenCalledOnce();
      expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});

describe("native quarantine receipt settlement", () => {
  it.each(["same-resource", "repeated-evidence", "case-replaced", "bot-identity-removed",
    "conflicting-bot", "conflicting-environment", "malformed-bot", "malformed-environment"] as const)(
    "only applies a receipt to its case-exact native resource with current bot evidence (%s)", async scenario => {
      const nativeId = "ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF";
      const environmentId = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB";
      const botId = nativeId;
      const at = new Date();
      const input: BeginGeneration = {
        scope: { kind: "principal", tenantId: "tenant", principalId: "principal", tokenMode: "delegated",
          source: "inventory_power_platform", selector: "complete" },
        schemaVersion: 1, sessionEpoch: "0", jobId: randomUUID(), jobKind: "fixture",
        observedAt: at, expiresAt: new Date(at.getTime() + 60_000), deadlineAt: new Date(at.getTime() + 60_000), reserveBytes: 1024,
      };
      const lease: GenerationLease = {
        id: randomUUID(), scopeId: randomUUID(), tenantId: input.scope.tenantId, owner: "worker",
        version: 1, epoch: "0", sessionEpoch: "0", expectedRevision: "1", schemaVersion: 1,
      };
      const previous = powerPlatformInventoryRecord({
        tenantId: input.scope.tenantId, nativeId: scenario === "case-replaced" ? nativeId.toLowerCase() : nativeId,
        type: "microsoft.copilotstudio/agents", location: null, displayName: "Agent", environmentId,
        createdAt: null, createdBy: null, lastPublishedAt: null, sourceSystem: "power_platform",
        authoringTool: "Copilot Studio", creatorType: "unknown", agentKind: "copilot_studio_agent",
        lifecycle: "published", identityConfidence: "exact_native", provenance: {}, unknownFieldCount: 0,
        identifiers: [{ kind: "environment_id", value: environmentId },
          ...(scenario === "bot-identity-removed" ? [] : [{ kind: "cds_bot_id" as const, value: botId }]),
          ...(scenario === "repeated-evidence" ? [
            { kind: "cds_bot_id" as const, value: botId.toLowerCase() },
            { kind: "environment_id" as const, value: environmentId.toLowerCase() },
          ] : []),
          ...(scenario === "conflicting-bot" || scenario === "malformed-bot"
            ? [{ kind: "cds_bot_id" as const, value: scenario === "malformed-bot" ? `${botId}\n` : environmentId }] : []),
          ...(scenario === "conflicting-environment" || scenario === "malformed-environment"
            ? [{ kind: "environment_id" as const, value: scenario === "malformed-environment" ? `${environmentId}\u2028` : botId }] : [])],
        details: { isQuarantined: false },
      });
      const previousId = randomUUID();
      const client = Object.assign(new pg.Client(), { release: vi.fn() });
      const rows = (value: object[]): pg.QueryResult => ({ command: "SELECT", oid: 0, fields: [], rowCount: value.length, rows: value });
      vi.spyOn(client, "query")
        .mockImplementationOnce(async () => rows([{ baseline_id: previousId, base_revision: "1" }]))
        .mockImplementationOnce(async () => rows([{ generation_id: previousId }]))
        .mockImplementationOnce(async () => rows([{ ...previous, generation_id: previousId, domain: "power_platform",
          read_started_at: at, observed_at: at, expires_at: input.expiresAt, catalog_generation: previousId }]))
        .mockImplementationOnce(async () => rows(previous.facts.filter(fact => fact.kind === "identifier").map((fact, ordinal) => ({
          ...fact, generation_id: previousId, identity: previous.identity, ordinal,
        }))))
        .mockImplementationOnce(async () => rows([]));
      const stream = new StreamedInventory(new pg.Pool({ max: 4 }));
      vi.spyOn(stream.stages, "execute").mockImplementation(async (_input, _intent, work) => {
        await work(lease, new AbortController().signal);
        return { scopeId: lease.scopeId, tenantId: lease.tenantId, baselineId: previousId, revision: "2", epoch: "0",
          inserted: 1, closed: 1, changed: 1 };
      });
      vi.spyOn(stream.stages, "fence").mockResolvedValue({ job_id: input.jobId });
      vi.spyOn(stream.stages.generations.connections, "run").mockImplementation(async operation => operation(client));
      const append = vi.spyOn(stream.stages, "appendBounded").mockResolvedValue(undefined);

      await stream.nativeControlReadback(input, {
        identity: previous.identity, nativeId, environmentId: environmentId.toLowerCase(), botId: botId.toLowerCase(),
        state: true, updatedAt: at.toISOString(), resourceTypes: ["microsoft.copilotstudio/agents"],
        environmentScope: null, roleScope: "full",
      }, { authorize: async () => {} });

      const saved = append.mock.calls[0][1][0];
      expect(saved.native_id).toBe(previous.native_id);
      expect(saved.residual.details).toMatchObject({ isQuarantined: scenario === "same-resource" || scenario === "repeated-evidence" });
      expect(saved.factSource).toMatchObject({ generationId: previousId, identity: previous.identity });
    },
  );
});

describe("package job control settlement commit fencing", () => {
  it.each([
    ...(["package-cleanup", "native-cleanup", "package-publication", "native-publication",
      "canonical-request", "canonical-claim", "canonical-publication"] as const).map(stage => ({ stage, cause: "deadline" as const })),
    ...(["package-publication", "canonical-publication"] as const).map(stage => ({ stage, cause: "authority" as const })),
  ])("rolls back $stage when $cause changes after an await with abort delivery delayed", async ({ stage, cause }) => {
    const scope = { tenantId: "settlement-tenant", principalId: "settlement-principal" };
    const signal = new AbortController().signal;
    const database = new pg.Pool({ max: 4 });
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    const at = new Date(), sourceId = randomUUID(), baselineId = randomUUID();
    const root = { scopeId: sourceId, tenantId: scope.tenantId, baselineId, revision: "1", epoch: "0",
      domain: "packages", expiresAt: new Date(at.getTime() + 86_400_000).toISOString() };
    const lease: GenerationLease = { id: randomUUID(), scopeId: sourceId, tenantId: scope.tenantId, owner: "worker",
      version: 1, epoch: "0", sessionEpoch: "0", expectedRevision: "1", schemaVersion: 1 };
    let elapsed = 0, current = true, publications = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const failure = cause === "deadline" ? new DOMException("Synthetic item deadline.", "TimeoutError")
      : new AppError(401, "authorization_expired", "Synthetic initiating authority loss.");
    const invalidate = () => { elapsed = 90_001; current = false; };
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (cause === "deadline" ? performance.now() >= 90_000 : !current) throw failure;
    };
    const rows = (value: object[] = [], command = "SELECT"): pg.QueryResult =>
      ({ command, rows: value, rowCount: value.length, fields: [], oid: 0 });
    vi.spyOn(database, "connect").mockImplementation(async () => client);
    vi.spyOn(database, "query").mockImplementation(async sql => {
      const statement = String(sql);
      if (statement.startsWith("SELECT 1 FROM job_items item JOIN jobs")) return rows([{}]);
      if (statement.startsWith("SELECT mode FROM operational_state")) return rows([{ mode: "normal" }]);
      if (statement.startsWith("SELECT p.target_id")) return rows(stage === "package-publication"
        ? [{ target_id: "package", observation_id: randomUUID(), updated_at: at }] : []);
      if (statement.startsWith("SELECT p.scope_id")) return rows(stage === "native-publication" ? [{
        scope_id: sourceId, identity: "native-agent", observation_id: randomUUID(), updated_at: at, receipt_observed_at: at,
        selector: '["",["microsoft.copilotstudio/agents"]]', resource_native_id: randomUUID(), environment_id: randomUUID(), bot_id: randomUUID(),
        is_bot_quarantined: true, provider_updated_at: at.toISOString(), environment_scope: null,
        resource_types: ["microsoft.copilotstudio/agents"], role_scope: "full",
      }] : []);
      if (statement.startsWith("SELECT r.scope_id")) return rows(stage.startsWith("canonical-") ? [root] : []);
      if (statement.startsWith("SELECT 1 WHERE")) return rows();
      throw new Error("Unexpected settlement database query.");
    });
    const query = vi.spyOn(client, "query").mockImplementation(async sql => {
      const statement = String(sql);
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(statement)) return rows([], statement);
      if (statement.startsWith("DELETE FROM inventory_control_pending")) {
        if (stage === "package-cleanup") invalidate();
        return rows([{}]);
      }
      if (statement.startsWith("DELETE FROM inventory_native_control_pending")) {
        if (stage === "native-cleanup") invalidate();
        return rows([{}]);
      }
      if (statement.startsWith("SELECT * FROM inventory_reconciliation")) {
        if (stage === "canonical-request") invalidate();
        return rows([{ pending_inputs: [root], published_inputs: [root], pending_sequence: "1", published_sequence: "0", active_id: null }]);
      }
      if (statement.startsWith("SELECT * FROM data_scope_epochs")) return rows([{
        principal_id: scope.principalId, token_mode: "delegated", epoch: "0", session_epoch: "0",
      }]);
      if (statement.startsWith("SELECT id FROM data_scope_epochs") || statement.startsWith("SELECT id,epoch FROM data_scope_epochs")) {
        return rows([{ id: sourceId, epoch: "0" }]);
      }
      if (statement.startsWith("SELECT r.domain,r.baseline_id,r.revision,g.expires_at")
        || statement.startsWith("SELECT r.baseline_id,r.revision,epoch.epoch,g.expires_at")) {
        return rows([{ domain: "packages", baseline_id: baselineId, revision: "1", epoch: "0", expires_at: new Date(root.expiresAt) }]);
      }
      if (statement.startsWith("SELECT * FROM inventory_roots") || statement.startsWith("SELECT r.* FROM inventory_roots")) {
        return rows([{ baseline_id: baselineId, revision: "1" }]);
      }
      if (statement.startsWith("WITH roots AS")) {
        if (stage === "canonical-claim") invalidate();
        return rows();
      }
      if (statement.includes("AS count")) return rows([{ count: 0 }]);
      if (statement.startsWith("SELECT 1 FROM inventory_worker_pins")
        || statement.startsWith("SELECT 1 FROM inventory_control_pending")
        || statement.startsWith("SELECT 1 FROM inventory_native_control_pending")
        || statement.startsWith("UPDATE inventory_reconciliation")) return rows([{}]);
      if (statement.startsWith("SELECT pg_advisory_xact_lock") || statement.startsWith("SET LOCAL")
        || statement.startsWith("INSERT INTO") || statement.startsWith("DELETE FROM inventory_worker_pins")) return rows();
      throw new Error("Unexpected settlement transaction query.");
    });
    vi.spyOn(DataGenerations.prototype, "sessionEpoch").mockResolvedValue("0");
    vi.spyOn(DataGenerations.prototype, "execute").mockImplementation(async (_input, work) => work(lease, signal));
    vi.spyOn(InventoryGenerations.prototype, "fence").mockResolvedValue({ job_id: lease.id });
    vi.spyOn(InventoryGenerations.prototype, "validate").mockResolvedValue(undefined);
    const execute = InventoryGenerations.prototype.execute;
    // Retain the real authorization/publication pipeline; replace only record staging.
    vi.spyOn(InventoryGenerations.prototype, "execute").mockImplementation(function (this: InventoryGenerations, input, intent, _work, options) {
      return execute.call(this, input, intent, async () => undefined, options);
    });
    vi.spyOn(DataGenerations.prototype, "publish").mockImplementation(async function (this: DataGenerations, _lease, options = {}) {
      await this.connections.run(async () => {
        await Promise.resolve();
        invalidate();
      }, false, signal, undefined, options.beforeCommit);
      publications += 1;
      return "2";
    });
    const authorize = vi.fn(async () => { assertCurrent(); });

    await expect(new JobRepository(database).settleInventoryControls({
      jobId: lease.id, scope, owner: lease.owner, version: lease.version,
    }, randomUUID(), signal, authorize, assertCurrent)).rejects.toBe(failure);

    expect(signal.aborted).toBe(false);
    expect(publications).toBe(0);
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    if (stage.endsWith("publication")) expect(authorize).toHaveBeenCalled();
    else expect(authorize).not.toHaveBeenCalled();
  });
});
