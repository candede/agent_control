import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditLog } from "../services/auditLog.js";
import { packageMutationStateHash } from "../services/packageMutationState.js";
import { createJobConfirmation, JobRepository, type JobIntentInput, type JobItem, type JobRow, type Lease } from "./jobs.js";
import { clientErrorState } from "./clientErrors.js";
import { AppError } from "../errors.js";
import { loadOperationalState } from "../services/operationalState.js";

beforeEach(async () => {
  await loadOperationalState({ query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [{
    mode: "normal",
  }] }) });
});
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const scope = { tenantId: "synthetic-tenant", principalId: "synthetic-operator" };
  const job: JobRow = {
    id: "11111111-1111-4111-8111-111111111111", tenant_id: scope.tenantId, principal_id: scope.principalId,
    token_mode: "delegated", capability: "graph.package.block.manage", action: "block",
    access_update: null, reassign_user_id: null, request_hash: "a".repeat(64),
    confirmation_hash: null, confirmation_summary: null, confirmed_at: null, status: "running", scope: "bulk",
    actor_username: "operator@example.invalid", actor_name: "Operator", request_path: "/api/agents/block",
    cancel_requested: false, lease_owner: "22222222-2222-4222-8222-222222222222", lease_version: 1,
    lease_until: new Date(Date.now() + 120_000), attempts: 1, created_at: new Date(), updated_at: new Date(),
    result_revision: "1",
  };
  const prestate = { kind: "block" as const, isBlocked: false };
  const item: JobItem = {
    id: "33333333-3333-4333-8333-333333333333", job_id: job.id, target_id: "package-1",
    display_name: "Package", ordinal: 0, status: "running", sent_at: null, message: null, error_code: null,
    prestate, prestate_hash: packageMutationStateHash(prestate), poststate: null, poststate_hash: null,
    correlation_id: "44444444-4444-4444-8444-444444444444", reconciliation_status: "not_required",
    reconciled_at: null,
  };
  const lease: Lease = { jobId: job.id, scope, owner: job.lease_owner!, version: job.lease_version };
  const database = new pg.Pool();
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  vi.spyOn(database, "connect").mockImplementation(async () => client);
  vi.spyOn(database, "query").mockRejectedValue(new Error("Unit tests must not access a database."));
  const result = (rows: object[] = []) => ({ command: "", oid: 0, fields: [], rowCount: rows.length, rows });
  const query = vi.fn(async (statement: unknown, _values?: unknown[]) => {
    if (typeof statement !== "string") throw new Error("Unexpected query shape.");
    if (statement.startsWith("SELECT pg_advisory_lock")) return result();
    if (statement.startsWith("SELECT pg_advisory_unlock")) return result([{ unlocked: true }]);
    if (statement.startsWith("SELECT epoch FROM data_principal_epochs")) {
      expect(_values).toEqual([scope.tenantId, scope.principalId]);
      return result([{ epoch: "0" }]);
    }
    if (statement.startsWith("SELECT * FROM jobs") || statement.startsWith("SELECT job.* FROM jobs")) return result([job]);
    if (statement.startsWith("INSERT INTO audit_events")) return result();
    if (statement.startsWith("SELECT 1 FROM job_items item JOIN jobs")) return result([{ id: item.id }]);
    if (statement.startsWith("UPDATE job_items SET status=")) return result([{ id: item.id }]);
    if (statement.startsWith("UPDATE job_attempts") || statement.startsWith("UPDATE jobs")
      || ["BEGIN", "COMMIT", "ROLLBACK"].includes(statement)) return result();
    throw new Error("Unexpected job database query.");
  });
  vi.spyOn(client, "query").mockImplementation(query);
  return { repository: new JobRepository(database), database, client, query, result, job, item, lease, scope };
}

describe("package mutation persistence boundaries without a database", () => {
  it.each(["execution", "reconciliation"] as const)("rejects oversized %s evidence before persisting a terminal or verified receipt", async mode => {
    const f = fixture();
    const observed = {
      kind: "access" as const, availableTo: "some" as const, deployedTo: "none" as const,
      allowedUsersAndGroups: Array.from({ length: 1000 }, (_, index) => ({
        resourceType: "user", resourceId: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
      })), acquireUsersAndGroups: [],
    };
    const normalQuery = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (...args) => String(args[0]).startsWith("SELECT item.*,attempt.lease_version")
      ? f.result([{ ...f.item, action: "update-availability", lease_version: f.lease.version }]) : normalQuery(...args));
    const operation = mode === "execution"
      ? f.repository.finishItem(f.lease, f.item.id, "succeeded", { poststate: observed })
      : f.repository.recordReconciliation(f.scope, f.item.id, "verified_applied", observed, "Synthetic readback.");
    await expect(operation).rejects.toMatchObject({ status: 413, code: "mutation_state_too_large" });
    expect(f.query.mock.calls.some(([statement]) => String(statement).startsWith("UPDATE job_items"))).toBe(false);
    expect(f.query).toHaveBeenCalledWith("ROLLBACK");
    expect(f.query).not.toHaveBeenCalledWith("COMMIT");
    expect(f.client.release).toHaveBeenCalledOnce();
  });

  it("rolls back a canary submission when its authority changes during the final audit write", async () => {
    const f = fixture();
    const intent: JobIntentInput = {
      action: "block", targets: [{ id: f.item.target_id, displayName: f.item.display_name, prestate: f.item.prestate }],
      scope: "single", requestPath: `/api/agents/mutation-canaries/${f.job.id}/execute/original`,
      actor: { tenantId: f.scope.tenantId, homeAccountId: f.scope.principalId, displayName: f.job.actor_name, username: f.job.actor_username },
    };
    let current = true;
    const failure = new AppError(401, "authorization_expired", "Synthetic capability replacement.");
    const normalQuery = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (...args) => {
      const sql = String(args[0]);
      if (sql.startsWith("SELECT * FROM jobs WHERE tenant_id") || sql.startsWith("SELECT pg_advisory_xact_lock")
        || sql.startsWith("INSERT INTO jobs") || sql.startsWith("INSERT INTO job_items") || sql.startsWith("INSERT INTO source_identifiers")) return f.result();
      if (sql.startsWith("SELECT count(*)::int AS count FROM jobs")) return f.result([{ count: 0 }]);
      return normalQuery(...args);
    });
    vi.spyOn(AuditLog.prototype, "requestEvents").mockImplementation(async () => { current = false; return []; });

    await expect(f.repository.submit(f.scope, {
      ...intent, confirmationHash: createJobConfirmation(intent).confirmationHash, idempotencyKey: "canary-original",
    }, () => { if (!current) throw failure; })).rejects.toBe(failure);
    expect(f.query).toHaveBeenCalledWith("ROLLBACK");
    expect(f.query).not.toHaveBeenCalledWith("COMMIT");
    expect(f.database.query).not.toHaveBeenCalled();
    expect(f.client.release).toHaveBeenCalledOnce();
  });

  it.each([
    { path: "/api/agents/block", canary: false },
    { path: "/api/agents/mutation-canaries/block", canary: false },
    { path: "/api/agents/mutation-canaries/11111111-1111-4111-8111-111111111111/execute/original", canary: true },
    { path: "/api/agents/mutation-canaries/11111111-1111-4111-8111-111111111111/execute/restoration", canary: true },
  ])("projects paused authority for $path without changing ordinary resumability", async ({ path, canary }) => {
    const f = fixture();
    vi.mocked(f.database.query).mockImplementation(async () => f.result([{
      ...f.job, request_path: path, status: "waiting_authorization", within_budget: true, current_agent_name: null,
      counts: { total: "1", completed: "0", succeeded: "0", failed: "0", skipped: "0", inconclusive: "0",
        cancelled: "0", queued: "1", reconciliationRequired: "0", retryEligible: "0" },
    }]));
    await expect(f.repository.get(f.job.id, f.scope)).resolves.toMatchObject({ canResume: !canary, ...(canary ? { isCanary: true } : {}) });
    expect(String(vi.mocked(f.database.query).mock.calls[0]?.[0])).toContain("job.request_path");
  });

  it.each([false, true])("fences repository resume without confusing exact package IDs with canary paths (canary: %s)", async canary => {
    const f = fixture();
    const path = canary ? `/api/agents/mutation-canaries/${f.job.id}/execute/original` : "/api/agents/mutation-canaries/block";
    const normalQuery = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (statement, values) => {
      const sql = String(statement);
      if (!sql.startsWith("UPDATE jobs SET status='running',lease_owner")) return normalQuery(statement, values);
      return f.result(sql.includes("AND (NOT $5 OR request_path !~ $6)") && new RegExp(String(values?.[5])).test(path) ? [] : [f.job]);
    });
    vi.spyOn(AuditLog.prototype, "completeEvent").mockResolvedValue({ id: "resume-event" } as never);
    const result = await f.repository.claim(f.job.id, f.scope, f.lease.owner, true);
    if (canary) expect(result).toBeUndefined();
    else expect(result).toMatchObject({ jobId: f.job.id });
  });

  it.each(["direct", "staged"] as const)("persists bounded %s job metadata without losing a large reviewed target set", async mode => {
    const f = fixture();
    const principals = Array.from({ length: 80 }, (_, index) => ({
      resourceType: "user", resourceId: `55555555-5555-4555-8555-${String(index).padStart(12, "0")}`,
    }));
    const intent: JobIntentInput = {
      action: "update-availability", accessUpdate: { target: "availability", mode: "add", scope: "specific", principals: [principals[0]] },
      scope: "bulk", actor: { tenantId: f.scope.tenantId, homeAccountId: f.scope.principalId,
        username: f.job.actor_username, displayName: f.job.actor_name }, requestPath: "/api/agents/access",
      targets: Array.from({ length: 20 }, (_, index) => ({
        id: `package-${String(index).padStart(2, "0")}`, displayName: `Package ${index}`,
        prestate: { kind: "access", availableTo: "some", deployedTo: "none", allowedUsersAndGroups: principals, acquireUsersAndGroups: [] },
      })),
    };
    const confirmation = createJobConfirmation(intent), stageId = "66666666-6666-4666-8666-666666666666";
    let persisted: unknown, jobId: unknown;
    const normalQuery = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (...args) => {
      const statement = String(args[0]), values = args[1];
      if (statement.startsWith("INSERT INTO jobs")) {
        jobId = values?.[0]; persisted = values?.[9];
        return f.result();
      }
      if (statement.includes("INSERT INTO job_items")) return f.result(mode === "staged" && values?.[2] === -1
        ? confirmation.prepared.targets.map((target, ordinal) => ({
          ordinal, target_id: target.id, display_name: target.displayName, prestate_hash: target.prestateHash,
        })) : []);
      if (statement.startsWith("SELECT * FROM jobs WHERE tenant_id") || statement.startsWith("SELECT id,confirmation_hash,request_hash FROM jobs")
        || statement.includes("WITH inventory AS") || statement.startsWith("SELECT pg_advisory_xact_lock")
        || statement.startsWith("INSERT INTO source_identifiers") || statement.startsWith("INSERT INTO audit_events")
        || statement.startsWith("UPDATE inventory_mutation_stages")) return f.result();
      if (statement.startsWith("SELECT count(*)::int AS count FROM jobs")) return f.result([{ count: 0 }]);
      if (statement.trimStart().startsWith("SELECT selection_id,intent,target_count")) return f.result([{
        selection_id: stageId, intent, target_count: intent.targets.length, request_hash: confirmation.requestHash,
        confirmation_hash: confirmation.confirmationHash, summary: confirmation.summary,
      }]);
      if (statement.startsWith("WITH current_sources AS MATERIALIZED")) return f.result([{ total: 20, valid: 20 }]);
      return normalQuery(...args);
    });
    vi.mocked(f.database.query).mockImplementation(async () => f.result([{
      ...f.job, id: jobId, status: "queued", capability: "graph.package.access.manage",
      action: intent.action, access_update: intent.accessUpdate, confirmation_hash: confirmation.confirmationHash,
      confirmation_summary: persisted, within_budget: true, current_agent_name: null,
      counts: { total: "20", completed: "0", succeeded: "0", failed: "0", skipped: "0",
        inconclusive: "0", cancelled: "0", queued: "20", reconciliationRequired: "0", retryEligible: "0" },
    }]));
    const input = { confirmationHash: confirmation.confirmationHash, idempotencyKey: "large-preview", requestPath: intent.requestPath };

    let receipt: Awaited<ReturnType<JobRepository["get"]>>;
    if (mode === "direct") receipt = await f.repository.submit(f.scope, { ...intent, ...input });
    else {
      const id = await f.repository.submitStaged(f.client, {
        ...f.scope, authorizationHash: "admin", sessionEpoch: "0",
      }, stageId, input);
      receipt = await f.repository.get(id, f.scope);
    }

    expect(receipt).toMatchObject({ id: jobId, total: 20, confirmationHash: confirmation.confirmationHash, confirmation: persisted });
    expect(Buffer.byteLength(JSON.stringify(confirmation.summary))).toBeGreaterThan(65_536);
    expect(Buffer.byteLength(JSON.stringify(persisted))).toBeLessThan(65_536);
    expect(persisted).not.toHaveProperty("targets");
    expect(persisted).toMatchObject({ targetCount: 20, targetSelectionHash: confirmation.summary.targetSelectionHash });
    expect(confirmation.summary.targets).toHaveLength(20);
    const jobInsert = f.query.mock.calls.find(([statement]) => String(statement).startsWith("INSERT INTO jobs"));
    expect(jobInsert?.[1]?.slice(7, 10)).toEqual([intent.accessUpdate, confirmation.confirmationHash, persisted]);
    const itemInsert = f.query.mock.calls.find(([statement]) => String(statement).includes("INSERT INTO job_items"));
    if (mode === "direct") expect(JSON.parse(String(itemInsert?.[1]?.[1])))
      .toEqual(confirmation.prepared.targets.map((target, ordinal) => ({
        ordinal, target_id: target.id, display_name: target.displayName, prestate_hash: target.prestateHash, prestate: target.prestate,
      })));
    else expect(String(itemInsert?.[0])).toContain("prestate,source_generation_id");
  });

  it.each([false, true])("honors persisted cancellation during an unsent authorization pause (%s)", async cancelled => {
    const f = fixture();
    f.job.cancel_requested = cancelled;
    const complete = vi.spyOn(AuditLog.prototype, "completeEvent");
    complete.mockImplementation(async (id, update) => ({
      id, operationId: f.job.id, scope: "bulk", action: "block", targetBlockedState: true, agentId: f.item.target_id,
      actor: { tenantId: f.scope.tenantId, homeAccountId: f.scope.principalId,
        username: f.job.actor_username, displayName: f.job.actor_name },
      startedAt: new Date().toISOString(), status: update.status, requestPath: f.job.request_path,
    }));

    await f.repository.pauseItemForAuthorization(f.lease, f.item.id);

    const itemUpdate = f.query.mock.calls.find(([statement]) => String(statement).startsWith("UPDATE job_items SET status="));
    const status = String(itemUpdate?.[0]).match(/SET status=(?:'([^']+)'|\$(\d+))/);
    expect(status?.[1] ?? itemUpdate?.[1]?.[Number(status?.[2]) - 1]).toBe(cancelled ? "cancelled" : "queued");
    expect(complete).toHaveBeenCalledWith(`${f.item.id}:${f.lease.version}`,
      expect.objectContaining({ status: "cancelled", message: cancelled
        ? "Cancellation stopped this attempt before provider dispatch."
        : "Attempt ended before dispatch because current authorization is required." }));
    expect(f.query).toHaveBeenCalledWith("COMMIT");
    expect(f.client.release).toHaveBeenCalledOnce();
  });

  it.each(["execution", "reconciliation"] as const)("releases the target lock after successful %s", async mode => {
    const f = fixture(), operation = vi.fn(async () => "verified");
    const run = () => mode === "execution" ? f.repository.withTargetLock(f.lease, f.item, operation)
      : f.repository.withReconciliationLock(f.scope, f.item, operation);

    await expect(run()).resolves.toBe("verified");

    expect(operation).toHaveBeenCalledOnce();
    expect(f.query.mock.calls.filter(([statement]) => String(statement).startsWith("SELECT pg_advisory_unlock")))
      .toEqual([[expect.any(String), [`package-mutation:${f.scope.tenantId}:${f.item.target_id}`]]]);
    expect(f.client.release).toHaveBeenCalledOnce();
    expect(f.client.release.mock.calls[0]?.[0]).toBeUndefined();
  });

  it.each((["execution", "reconciliation"] as const).flatMap(mode =>
    (["rejected", "not-owned"] as const).map(outcome => ({ mode, outcome }))))(
    "discards a $mode lock connection when unlock is $outcome", async ({ mode, outcome }) => {
      const f = fixture(), operation = vi.fn(async () => "verified"), failure = new Error("Synthetic unlock failure.");
      const normalQuery = f.query.getMockImplementation()!;
      f.query.mockImplementation(async (...args) => {
        if (String(args[0]).startsWith("SELECT pg_advisory_unlock")) {
          if (outcome === "rejected") throw failure;
          return f.result([{ unlocked: false }]);
        }
        return normalQuery(...args);
      });

      const execution = mode === "execution" ? f.repository.withTargetLock(f.lease, f.item, operation)
        : f.repository.withReconciliationLock(f.scope, f.item, operation);

      await expect(execution).rejects.toThrow(outcome === "rejected" ? failure.message : "package_mutation_unlock_failed");
      expect(operation).toHaveBeenCalledOnce();
      expect(f.client.release).toHaveBeenCalledExactlyOnceWith(outcome === "rejected" ? failure : expect.any(Error));
    },
  );

  it("preserves both the operation and cleanup errors when releasing a package lock", async () => {
    const f = fixture(), failure = new Error("Synthetic operation failure."), cleanup = new Error("Synthetic unlock failure.");
    const normalQuery = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (...args) => {
      if (String(args[0]).startsWith("SELECT pg_advisory_unlock")) throw cleanup;
      return normalQuery(...args);
    });

    await expect(f.repository.withTargetLock(f.lease, f.item, async () => { throw failure; }))
      .rejects.toMatchObject({ name: "AggregateError", errors: [failure, cleanup] });
    expect(f.client.release).toHaveBeenCalledExactlyOnceWith(cleanup);
  });

  it("discards a failed lock acquisition without attempting work or unlocking an unowned target", async () => {
    const f = fixture(), failure = new Error("Synthetic lock acquisition failure."), operation = vi.fn(async () => "verified");
    f.query.mockRejectedValueOnce(failure);

    await expect(f.repository.withTargetLock(f.lease, f.item, operation)).rejects.toBe(failure);

    expect(operation).not.toHaveBeenCalled();
    expect(f.query).toHaveBeenCalledOnce();
    expect(f.client.release).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it("retains a checked-out client error and discards the connection even if its operation returns", async () => {
    const f = fixture(), failure = new Error("Synthetic checked-out connection failure.");

    await expect(f.repository.withTargetLock(f.lease, f.item, async () => {
      f.client.emit("error", failure);
      return "verified";
    })).rejects.toBe(failure);

    expect(f.client.release).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it.each((["execution", "reconciliation"] as const).flatMap(mode =>
    (["error", "end"] as const).map(event => ({ mode, event }))))("interrupts active $mode as soon as its target-lock connection emits $event", async ({ mode, event }) => {
    const f = fixture(), failure = new Error("Synthetic checked-out connection failure.");
    const operation = vi.fn(async (signal: AbortSignal) => {
      expect(signal.aborted).toBe(false);
      f.client.emit(event, event === "error" ? failure : undefined);
      expect(signal.aborted).toBe(true);
      signal.throwIfAborted();
    });
    clientErrorState(f.client);
    const listeners = f.client.listenerCount("error"), endListeners = f.client.listenerCount("end");

    const execution = mode === "execution" ? f.repository.withTargetLock(f.lease, f.item, operation)
      : f.repository.withReconciliationLock(f.scope, f.item, operation);

    await expect(execution).rejects.toMatchObject({ code: "package_lock_lost" });
    expect(operation).toHaveBeenCalledOnce();
    expect(f.client.release).toHaveBeenCalledExactlyOnceWith(event === "error" ? failure : expect.objectContaining({ code: "package_lock_lost" }));
    expect(f.client.listenerCount("error")).toBe(listeners);
    expect(f.client.listenerCount("end")).toBe(endListeners);
  });

  it.each((["dispatch", "outcome", "reconciliation"] as const).flatMap(mode =>
    (["lock", "authority"] as const).map(cause => ({ mode, cause }))))("rolls back $mode when $cause changes before commit", async ({ mode, cause }) => {
    const f = fixture(), controller = new AbortController();
    const failure = new AppError(409, cause === "lock" ? "package_lock_lost" : "authority_changed", "Synthetic authority loss.");
    let current = true;
    const invalidate = () => {
      if (cause === "lock") controller.abort(failure);
      else current = false;
    };
    const assertCurrent = () => { if (!current) throw failure; };
    const normalQuery = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (...args) => {
      const statement = String(args[0]);
      if (statement.startsWith("SELECT pg_advisory_xact_lock")) return f.result();
      if (statement.startsWith("WITH inventory AS")) return f.result();
      if (statement.startsWith("SELECT deadline_at>clock_timestamp()")) return f.result([{ valid: true }]);
      if (statement.startsWith("SELECT source_generation_id")) return f.result([{ source_generation_id: null }]);
      if (statement.startsWith("UPDATE job_items SET sent_at")) return f.result([{ id: f.item.id }]);
      if (statement.startsWith("SELECT item.*,attempt.lease_version")) return f.result([{ ...f.item, lease_version: f.lease.version, action: f.job.action }]);
      const result = await normalQuery(...args);
      if (statement.startsWith("UPDATE jobs")) invalidate();
      return result;
    });
    vi.spyOn(AuditLog.prototype, "completeEvent").mockImplementation(async (id, update) => {
      if (mode === "outcome") invalidate();
      return {
        id, operationId: f.job.id, scope: "bulk", action: "block", targetBlockedState: true, agentId: f.item.target_id,
        actor: { tenantId: f.scope.tenantId, homeAccountId: f.scope.principalId,
          username: f.job.actor_username, displayName: f.job.actor_name },
        startedAt: new Date().toISOString(), status: update.status, requestPath: f.job.request_path,
      };
    });
    const state = { kind: "block" as const, isBlocked: true };
    const operation = mode === "dispatch" ? f.repository.markSent(f.lease, f.item.id, f.item.prestate_hash, controller.signal, assertCurrent)
      : mode === "outcome" ? f.repository.finishItem(f.lease, f.item.id, "succeeded", { poststate: state }, controller.signal, assertCurrent)
        : f.repository.recordReconciliation(f.scope, f.item.id, "verified_applied", state, "Synthetic observation.", undefined, controller.signal, assertCurrent);

    await expect(operation).rejects.toBe(failure);
    expect(f.query).toHaveBeenCalledWith("ROLLBACK");
    expect(f.query).not.toHaveBeenCalledWith("COMMIT");
    expect(f.client.release).toHaveBeenCalledOnce();
  });
});
