import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import { clientErrorState } from "./clientErrors.js";
import { CopilotStudioQuarantineRepository, createQuarantineConfirmation, type QuarantineItemRow, type QuarantineJobRow } from "./copilotStudioQuarantine.js";
import { NativeInventory, nativeTarget } from "./nativeInventory.js";

vi.mock("../services/operationalState.js", () => ({ requireProviderAdmissions: vi.fn() }));

afterEach(() => vi.restoreAllMocks());

const scope = { tenantId: "tenant-a", principalId: "operator-a" };
const target = {
  resourceNativeId: "Native-Agent", displayName: "Agent", snapshotId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  inventoryObservedAt: "2026-09-09T19:00:00Z", inventoryExpiresAt: "2026-09-10T19:00:00Z",
  environmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", botId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  inventoryQuarantineState: false, inventoryQuarantinedAt: null,
  directStatus: { environmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", botId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    isBotQuarantined: false, lastUpdateTimeUtc: "2026-09-09T19:00:00.1234567Z", observedAt: "2026-09-09T19:01:00Z",
    correlationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" },
};
const input = {
  action: "quarantine" as const, targets: [target],
  actor: { tenantId: scope.tenantId, homeAccountId: scope.principalId, displayName: "Operator", username: "operator@example.invalid" },
  authority: { contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1 },
  requestPath: "/api/quarantine/jobs",
};
const confirmation = createQuarantineConfirmation(input);
const identity = { action: input.action, snapshotId: target.snapshotId, resourceNativeIds: [target.resourceNativeId],
  confirmationHash: confirmation.confirmationHash, idempotencyKey: "same-key" };

function fixture() {
  const database = new pg.Pool();
  const now = new Date();
  const job: QuarantineJobRow = {
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", tenant_id: scope.tenantId, principal_id: scope.principalId,
    action: input.action, status: "succeeded", request_hash: confirmation.requestHash, confirmation_hash: confirmation.confirmationHash,
    confirmation_summary: confirmation.summary, actor_name: input.actor.displayName, actor_username: input.actor.username,
    request_path: input.requestPath, contract_revision: input.authority.contractRevision, permission_revision: input.authority.permissionRevision,
    configuration_revision: "1", is_canary: false, canary_approval_id: null, cancel_requested: false,
    lease_owner: null, lease_version: "1", lease_until: null, attempts: 1, created_at: now, updated_at: now,
    deadline_at: new Date(now.getTime() + 60_000), expires_at: new Date(now.getTime() + 60_000),
  };
  const item: QuarantineItemRow = {
    id: "ffffffff-ffff-4fff-8fff-ffffffffffff", job_id: job.id, ordinal: 0, resource_native_id: target.resourceNativeId,
    display_name: target.displayName, snapshot_id: target.snapshotId, inventory_observed_at: new Date(target.inventoryObservedAt),
    environment_id: target.environmentId, bot_id: target.botId, prestate: false,
    prestate_provider_updated_at: target.directStatus.lastUpdateTimeUtc, requested_state: true, status: "succeeded",
    sent_at: now, correlation_id: target.directStatus.correlationId, observed_state: true,
    observed_provider_updated_at: "2026-09-09T19:02:00Z", observed_at: now, readback_count: 1,
    reconciliation_status: "not_required", reconciled_at: null, error_code: null, message: null,
  };
  const result = (rows: object[]) => ({ command: "", oid: 0, fields: [], rowCount: rows.length, rows });
  const query = vi.fn(async (_text: unknown, _values?: unknown) => result([]))
    .mockResolvedValueOnce(result([job])).mockResolvedValueOnce(result([item]));
  vi.spyOn(database, "query").mockImplementation(query);
  return { repository: new CopilotStudioQuarantineRepository(database), database, query, job, item, result };
}

describe("quarantine submission receipt identity without a database", () => {
  it("does not remap a case-changed opaque resource GUID to a normalized inventory lookup result", async () => {
    const f = fixture();
    const client = new pg.Client();
    const nativeId = target.botId.toUpperCase();
    vi.spyOn(client, "query").mockImplementation(vi.fn(async () => f.result([{ native_id: nativeId }])));
    const inventory = new NativeInventory(f.database);
    const read = { client, at: new Date() };
    await expect(inventory.exact(scope, nativeId.toLowerCase(), read, target.snapshotId))
      .rejects.toMatchObject({ code: "quarantine_target_unavailable" });
    await expect(inventory.exact(scope, nativeId, read, target.snapshotId)).resolves.toMatchObject({ native_id: nativeId });
  });

  it.each([false, true])("offers ordinary resume only for non-canary unsent jobs (canary=%s)", async isCanary => {
    const f = fixture();
    Object.assign(f.job, { status: "waiting_authorization", is_canary: isCanary,
      deadline_at: new Date(Date.now() + 60_000) });
    Object.assign(f.item, { status: "queued", sent_at: null });

    await expect(f.repository.get(scope, f.job.id).then(job => job?.canResume)).resolves.toBe(!isCanary);
  });

  it.each([target.snapshotId, target.snapshotId.toUpperCase()])("retrieves the exact receipt with snapshot UUID %s", async snapshotId => {
    const { repository, query, job } = fixture();
    await expect(repository.existingSubmission(scope, { ...identity, snapshotId })).resolves.toMatchObject({ id: job.id, status: job.status });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][1]).toEqual([scope.tenantId, scope.principalId, identity.idempotencyKey]);
  });

  function leaseFixture() {
    const f = fixture();
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    vi.spyOn(f.database, "connect").mockImplementation(vi.fn(async () => client));
    const nativeRow: Parameters<typeof nativeTarget>[0] = {
      native_id: target.resourceNativeId, environment_id: target.environmentId, generation_id: target.snapshotId,
      root_generation_id: target.snapshotId, observed_at: f.job.created_at, expires_at: f.job.expires_at,
      residual: { tenantId: scope.tenantId, nativeId: target.resourceNativeId, type: "microsoft.copilotstudio/agents",
        location: null, displayName: target.displayName, environmentId: target.environmentId, createdAt: null, createdBy: null,
        lastPublishedAt: null, sourceSystem: "power_platform", authoringTool: "Copilot Studio", creatorType: "unknown",
        agentKind: "copilot_studio_agent", lifecycle: "published", identityConfidence: "exact_native",
        provenance: {}, details: {}, unknownFieldCount: 0 }, identifiers: [], identifier_count: 0,
      control: { environmentId: f.item.environment_id, botId: f.item.bot_id },
    };
    const query = vi.fn(async (text: unknown, _values?: unknown) => {
      if (typeof text === "string" && text.startsWith("SELECT * FROM copilot_quarantine_jobs")) return f.result([f.job]);
      if (typeof text === "string" && text.startsWith("SELECT * FROM copilot_quarantine_job_items")) return f.result([{ ...f.item, status: "queued", sent_at: null }]);
      if (String(text).startsWith("SELECT clock_timestamp()")) return f.result([{ now: f.job.created_at }]);
      if (String(text).startsWith("WITH live AS")) return f.result([nativeRow]);
      if (typeof text === "string" && text.startsWith("SELECT pg_advisory_unlock")) return f.result([{ unlocked: true }]);
      return f.result([]);
    });
    vi.spyOn(client, "query").mockImplementation(query);
    return { ...f, query, client, lease: { jobId: f.job.id, scope, owner: "worker", version: 1 } };
  }

  describe("quarantine target-lock boundaries without a database", () => {
    it("accepts provider GUID casing aliases while preserving the frozen source evidence", () => {
      const source = { ...target, environmentId: `Default-${target.environmentId.toUpperCase()}`, botId: target.botId.toUpperCase() };
      const directStatus = { ...target.directStatus, environmentId: source.environmentId.toLowerCase() };
      const confirmed = createQuarantineConfirmation({ ...input, targets: [{ ...source, directStatus }] });
      expect(confirmed.targets[0]).toEqual({ ...source, directStatus });
      expect(confirmed.summary.targets[0]).toMatchObject({ environmentId: source.environmentId, botId: source.botId });
    });

    it.each(["environmentId", "botId"] as const)("still rejects provider evidence for a different %s", field => {
      expect(() => createQuarantineConfirmation({ ...input, targets: [{ ...target,
        directStatus: { ...target.directStatus, [field]: "11111111-1111-4111-8111-111111111111" } }] }))
        .toThrow(expect.objectContaining({ code: "invalid_quarantine_target" }));
    });

    it("counts qualification requests by canonical native GUID identity", async () => {
      const f = fixture();
      f.query.mockReset().mockResolvedValue(f.result([{ target_environment_id: target.environmentId, target_bot_id: target.botId }]));
      const alias = { environmentId: target.environmentId.toUpperCase(), botId: target.botId.toUpperCase() };
      await expect(f.repository.isQualified(scope, input.authority, [target, alias])).resolves.toBe(true);
      await expect(f.repository.isQualified(scope, input.authority, [target, { ...alias, botId: "11111111-1111-4111-8111-111111111111" }]))
        .resolves.toBe(false);
    });

    it("accepts source/control environment casing aliases but not a different environment", () => {
      const at = new Date(target.inventoryObservedAt);
      const control = { environmentId: target.environmentId.toUpperCase(), botId: target.botId.toUpperCase() };
      const row: Parameters<typeof nativeTarget>[0] = {
        native_id: target.resourceNativeId, environment_id: target.environmentId, generation_id: target.snapshotId,
        root_generation_id: target.snapshotId, observed_at: at, expires_at: new Date(target.inventoryExpiresAt),
        residual: { tenantId: scope.tenantId, nativeId: target.resourceNativeId, type: "microsoft.copilotstudio/agents",
          location: null, displayName: target.displayName, environmentId: target.environmentId, createdAt: null, createdBy: null,
          lastPublishedAt: null, sourceSystem: "power_platform", authoringTool: "Copilot Studio", creatorType: "unknown",
          agentKind: "copilot_studio_agent", lifecycle: "published", identityConfidence: "exact_native",
          provenance: {}, details: {}, unknownFieldCount: 0 }, identifiers: [], identifier_count: 0,
        control,
      };
      expect(nativeTarget(row, at)).toMatchObject(control);
      expect(() => nativeTarget({ ...row, environment_id: "11111111-1111-4111-8111-111111111111" }, at))
        .toThrow(expect.objectContaining({ code: "quarantine_native_identity_unavailable" }));
    });

    it.each(["observation", "outcome", "reconciliation"] as const)("persists %s for provider GUID casing aliases", async mode => {
      const f = leaseFixture();
      const source = { ...target, environmentId: target.environmentId.toUpperCase(), botId: target.botId.toUpperCase() };
      f.item.environment_id = source.environmentId;
      f.item.bot_id = source.botId;
      const normalQuery = f.query.getMockImplementation()!;
      f.query.mockImplementation(async text => {
        if (String(text).startsWith("SELECT * FROM copilot_quarantine_jobs")) return f.result([f.job]);
        if (String(text).startsWith("UPDATE copilot_quarantine_job_items SET")) return f.result([f.item]);
        return normalQuery(text);
      });
      const pending = mode === "observation" ? f.repository.recordObservation(scope, source, target.directStatus)
        : mode === "outcome" ? f.repository.finishItem(f.lease, f.item, "succeeded", { observed: target.directStatus })
          : f.repository.recordReconciliation(scope, f.job, f.item, "verified_applied", target.directStatus, "Observed.");
      await pending;
      expect(f.query).toHaveBeenCalledWith("COMMIT");
      const inserted = f.query.mock.calls.find(([text]) => String(text).startsWith("INSERT INTO copilot_quarantine_status_observations"));
      expect(inserted?.[1]).toEqual(expect.arrayContaining([target.environmentId, target.botId]));
      expect(inserted?.[1]).not.toEqual(expect.arrayContaining([source.environmentId, source.botId]));
    });

    it.each(["outcome", "reconciliation"] as const)(
      "rejects %s readback publication when the exact inventory target disappears after GET", async mode => {
        const f = leaseFixture();
        const failure = new AppError(409, "quarantine_target_unavailable", "Target evidence was superseded.");
        const exact = vi.spyOn(NativeInventory.prototype, "exact").mockRejectedValue(failure);
        const pending = mode === "outcome"
          ? f.repository.finishItem(f.lease, f.item, "succeeded", { observed: target.directStatus })
          : f.repository.recordReconciliation(scope, f.job, f.item, "verified_applied", target.directStatus, "Observed.");
        await expect(pending).rejects.toBe(failure);
        expect(exact).toHaveBeenCalledWith(scope, f.item.resource_native_id, expect.anything(), undefined, f.item.environment_id);
        expect(f.query).toHaveBeenCalledWith("ROLLBACK");
        expect(f.query).not.toHaveBeenCalledWith("COMMIT");
        expect(f.query.mock.calls.some(([text]) => String(text).startsWith("INSERT INTO copilot_quarantine_status_observations"))).toBe(false);
      },
    );

    it.each(["begin", "dispatch", "outcome", "no-op"] as const)(
      "rejects expired job authority before %s while still permitting uncertain-write persistence", async mode => {
        const f = leaseFixture();
        f.job.deadline_at = new Date(f.job.created_at.getTime() - 1);
        const normalQuery = f.query.getMockImplementation()!;
        f.query.mockImplementation(async text => String(text).startsWith("UPDATE copilot_quarantine_job_items SET")
          ? f.result([f.item]) : normalQuery(text));
        const pending = mode === "begin" ? f.repository.beginItem(f.lease)
          : mode === "dispatch" ? f.repository.markSent(f.lease, f.item, input.authority)
            : f.repository.finishItem(f.lease, f.item, mode === "outcome" ? "succeeded" : "skipped", { observed: target.directStatus });
        await expect(pending).rejects.toMatchObject({ code: "quarantine_job_expired" });
        expect(f.query).not.toHaveBeenCalledWith("COMMIT");
        expect(f.query.mock.calls.some(([text]) => String(text).startsWith("UPDATE copilot_quarantine_job_items SET"))).toBe(false);
        await expect(f.repository.finishItem(f.lease, f.item, "inconclusive")).resolves.toBeUndefined();
        expect(f.query).toHaveBeenCalledWith("COMMIT");
      },
    );

    it.each(["succeeded", "skipped"] as const)("rejects %s publication after persisted cancellation", async outcome => {
      const f = leaseFixture();
      f.job.cancel_requested = true;
      await expect(f.repository.finishItem(f.lease, f.item, outcome, { observed: target.directStatus }))
        .rejects.toMatchObject({ code: "cancelled" });
      expect(f.query).not.toHaveBeenCalledWith("COMMIT");
      expect(f.query.mock.calls.some(([text]) => String(text).startsWith("INSERT INTO copilot_quarantine_status_observations"))).toBe(false);
    });

    it("rejects verified canary publication when its approval is no longer claimed", async () => {
      const f = leaseFixture();
      f.job.is_canary = true;
      f.job.canary_approval_id = target.snapshotId;
      await expect(f.repository.finishItem(f.lease, f.item, "succeeded", { observed: target.directStatus }))
        .rejects.toMatchObject({ code: "qualification_invalidated" });
      expect(f.query).not.toHaveBeenCalledWith("COMMIT");
    });

    it.each([
      { boundary: "cancellation", code: "cancelled" },
      { boundary: "deadline", code: "quarantine_job_expired" },
      { boundary: "canary", code: "qualification_invalidated" },
    ])("fences inconclusive readback publication after persisted $boundary without blocking evidence-free cleanup", async ({ boundary, code }) => {
      const f = leaseFixture();
      Object.assign(f.job, { status: "running", lease_owner: f.lease.owner, lease_until: f.job.expires_at });
      f.item.status = "running";
      if (boundary === "cancellation") f.job.cancel_requested = true;
      if (boundary === "deadline") f.job.deadline_at = new Date(f.job.created_at.getTime() - 1);
      if (boundary === "canary") {
        f.job.is_canary = true;
        f.job.canary_approval_id = target.snapshotId;
      }
      const normalQuery = f.query.getMockImplementation()!;
      f.query.mockImplementation(async (...args) => String(args[0]).startsWith("UPDATE copilot_quarantine_job_items SET")
        ? f.result([f.item]) : normalQuery(...args));

      await expect(f.repository.finishItem(f.lease, f.item, "inconclusive", {
        observed: target.directStatus, readbackCount: 5, errorCode: "verification_inconclusive",
      })).rejects.toMatchObject({ code });
      expect(f.query).toHaveBeenCalledWith("ROLLBACK");
      expect(f.query).not.toHaveBeenCalledWith("COMMIT");
      expect(f.query.mock.calls.some(([text]) => String(text).startsWith("INSERT INTO copilot_quarantine_status_observations"))).toBe(false);

      await expect(f.repository.finishItem(f.lease, f.item, "inconclusive", {
        errorCode: "verification_inconclusive",
      })).resolves.toBeUndefined();
      expect(f.query).toHaveBeenCalledWith("COMMIT");
    });

    it.each(["environmentId", "botId"] as const)("rejects an observation for a different %s before persistence", async field => {
      const f = leaseFixture();
      await expect(f.repository.recordObservation(scope, target, {
        ...target.directStatus, [field]: "11111111-1111-4111-8111-111111111111",
      })).rejects.toMatchObject({ code: "target_mismatch" });
      expect(f.query).not.toHaveBeenCalled();
    });

    it("serializes native GUID casing aliases under the same target lock", async () => {
      const f = leaseFixture();
      await f.repository.withTargetLock(f.lease, f.item, async () => undefined);
      await f.repository.withTargetLock(f.lease, {
        ...f.item, environment_id: f.item.environment_id.toUpperCase(), bot_id: f.item.bot_id.toUpperCase(),
      }, async () => undefined);
      const keys = f.query.mock.calls.filter(([text]) => String(text).startsWith("SELECT pg_advisory_lock"))
        .map(([, values]) => values);
      expect(keys).toHaveLength(2);
      expect(keys[0]).toEqual(keys[1]);
    });

    it("rejects duplicate native GUID casing aliases before confirmation", () => {
      const alias = { ...target, resourceNativeId: "alias-agent", environmentId: target.environmentId.toUpperCase(),
        botId: target.botId.toUpperCase(), directStatus: { ...target.directStatus,
          environmentId: target.environmentId.toUpperCase(), botId: target.botId.toUpperCase() } };
      expect(() => createQuarantineConfirmation({ ...input, targets: [target, alias] }))
        .toThrow(expect.objectContaining({ code: "duplicate_target" }));
    });

    it.each((["execution", "reconciliation"] as const).flatMap(mode =>
      (["error", "end"] as const).map(event => ({ mode, event }))))(
      "interrupts $mode when its target-lock connection emits $event and removes listeners", async ({ mode, event }) => {
        const f = leaseFixture(), failure = new Error("Synthetic lock connection failure.");
        clientErrorState(f.client);
        const errors = f.client.listenerCount("error"), ends = f.client.listenerCount("end");
        const operation = vi.fn(async (signal: AbortSignal) => {
          f.client.emit(event, event === "error" ? failure : undefined);
          expect(signal.aborted).toBe(true);
          signal.throwIfAborted();
        });
        const normalQuery = f.query.getMockImplementation()!;
        f.query.mockImplementation(async (...args) => String(args[0]).startsWith("SELECT 1 FROM copilot_quarantine_job_items item")
          ? f.result([{ id: f.item.id }]) : normalQuery(...args));

        const pending = mode === "execution" ? f.repository.withTargetLock(f.lease, f.item, operation)
          : f.repository.withReconciliationLock(scope, f.item, operation);
        await expect(pending).rejects.toMatchObject({ code: "quarantine_lock_lost" });
        expect(f.client.release).toHaveBeenCalledExactlyOnceWith(event === "error" ? failure
          : expect.objectContaining({ code: "quarantine_lock_lost" }));
        expect(f.client.listenerCount("error")).toBe(errors);
        expect(f.client.listenerCount("end")).toBe(ends);
      },
    );

    it.each(["rejected", "not-owned"] as const)("discards the connection and reports %s lock cleanup", async outcome => {
      const f = leaseFixture(), failure = new Error("Synthetic unlock failure.");
      const normalQuery = f.query.getMockImplementation()!;
      f.query.mockImplementation(async (...args) => {
        if (String(args[0]).startsWith("SELECT pg_advisory_unlock")) {
          if (outcome === "rejected") throw failure;
          return f.result([{ unlocked: false }]);
        }
        return normalQuery(...args);
      });
      await expect(f.repository.withTargetLock(f.lease, f.item, async () => "verified"))
        .rejects.toThrow(outcome === "rejected" ? failure.message : "quarantine_unlock_failed");
      expect(f.client.release).toHaveBeenCalledExactlyOnceWith(outcome === "rejected" ? failure : expect.any(Error));
    });

    it.each((["execution", "reconciliation"] as const).flatMap(mode =>
      (["rejected", "not-owned", "connection-lost"] as const).map(outcome => ({ mode, outcome }))))(
      "preserves the primary $mode error when lock cleanup is $outcome", async ({ mode, outcome }) => {
        const f = leaseFixture();
        const primary = new AppError(409, "quarantine_prestate_conflict", "Primary provider details.");
        const cleanup = new Error("Sensitive unlock details.");
        const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const normalQuery = f.query.getMockImplementation()!;
        f.query.mockImplementation(async (...args) => {
          const statement = String(args[0]);
          if (statement.startsWith("SELECT 1 FROM copilot_quarantine_job_items item")) return f.result([{ id: f.item.id }]);
          if (statement.startsWith("SELECT pg_advisory_unlock")) {
            if (outcome === "connection-lost") { f.client.emit("error", cleanup); throw cleanup; }
            if (outcome === "rejected") throw cleanup;
            return f.result([{ unlocked: false }]);
          }
          return normalQuery(...args);
        });
        let operationSignal: AbortSignal | undefined;
        const operation = async (signal: AbortSignal) => { operationSignal = signal; throw primary; };
        const pending = mode === "execution" ? f.repository.withTargetLock(f.lease, f.item, operation)
          : f.repository.withReconciliationLock(scope, f.item, operation);

        await expect(pending).rejects.toBe(primary);
        expect(operationSignal?.aborted).toBe(false);
        expect(f.client.release).toHaveBeenCalledExactlyOnceWith(outcome === "not-owned" ? expect.any(Error) : cleanup);
        expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('"stage":"target_unlock"'));
        expect(JSON.stringify(log.mock.calls)).not.toContain("details");
      },
    );

    it.each(["dispatch", "outcome", "reconciliation"] as const)("rolls back %s when lock loss arrives before commit", async mode => {
      const f = leaseFixture(), controller = new AbortController();
      const failure = new AppError(409, "quarantine_lock_lost", "Synthetic lock loss.");
      f.query.mockImplementation(async text => {
        const statement = String(text);
        if (statement.startsWith("SELECT * FROM copilot_quarantine_jobs")) return f.result([f.job]);
        if (statement.startsWith("SELECT clock_timestamp()")) return f.result([{ now: f.job.created_at }]);
        if (statement.startsWith("WITH live AS")) return f.result([{
          native_id: target.resourceNativeId, environment_id: target.environmentId, generation_id: target.snapshotId,
          root_generation_id: target.snapshotId, observed_at: f.job.created_at, expires_at: f.job.expires_at,
          residual: { displayName: target.displayName, details: {} }, identifiers: [], identifier_count: 0,
          control: { environmentId: target.environmentId, botId: target.botId },
        }]);
        if (statement.startsWith("UPDATE copilot_quarantine_job_items SET")) return f.result([f.item]);
        if (statement.startsWith("INSERT INTO copilot_quarantine_audit")) controller.abort(failure);
        return f.result([]);
      });
      const pending = mode === "dispatch" ? f.repository.markSent(f.lease, f.item, input.authority, controller.signal)
        : mode === "outcome" ? f.repository.finishItem(f.lease, f.item, "succeeded", { observed: target.directStatus }, controller.signal)
          : f.repository.recordReconciliation(scope, f.job, f.item, "verified_applied", target.directStatus, "Observed.", controller.signal);
      await expect(pending).rejects.toBe(failure);
      expect(f.query).toHaveBeenCalledWith("ROLLBACK");
      expect(f.query).not.toHaveBeenCalledWith("COMMIT");
      expect(f.client.release).toHaveBeenCalledOnce();
    });

    it.each(["observation", "submission", "dispatch", "outcome", "reconciliation"] as const)("rechecks %s publication authority before commit", async mode => {
      const f = leaseFixture(), failure = new AppError(401, "unauthorized", "The initiating session was superseded.");
      const validate = vi.fn(() => { throw failure; });
      vi.mocked(f.database.query).mockReset().mockImplementation(vi.fn(async () => f.result([])));
      f.query.mockImplementation(async text => {
        const statement = String(text);
        if (mode === "submission" && statement.startsWith("SELECT * FROM copilot_quarantine_jobs")) return f.result([]);
        if (statement.startsWith("SELECT count(*)::int AS count")) return f.result([{ count: 0 }]);
        if (statement.startsWith("SELECT * FROM copilot_quarantine_jobs")) return f.result([f.job]);
        if (statement.startsWith("SELECT clock_timestamp()")) return f.result([{ now: f.job.created_at }]);
        if (statement.startsWith("WITH live AS")) return f.result([{
          native_id: target.resourceNativeId, environment_id: target.environmentId, generation_id: target.snapshotId,
          root_generation_id: target.snapshotId, observed_at: f.job.created_at, expires_at: f.job.expires_at,
          residual: { displayName: target.displayName, details: {} }, identifiers: [], identifier_count: 0,
          control: { environmentId: target.environmentId, botId: target.botId },
        }]);
        if (statement.startsWith("UPDATE copilot_quarantine_job_items SET")) return f.result([f.item]);
        return f.result([]);
      });
      const pending = mode === "observation" ? f.repository.recordObservation(scope, target, target.directStatus, validate)
        : mode === "submission" ? f.repository.submit(scope, { ...input, idempotencyKey: identity.idempotencyKey, confirmationHash: identity.confirmationHash }, validate)
          : mode === "dispatch" ? f.repository.markSent(f.lease, f.item, input.authority, undefined, validate)
            : mode === "outcome" ? f.repository.finishItem(f.lease, f.item, "succeeded", { observed: target.directStatus }, undefined, validate)
              : f.repository.recordReconciliation(scope, f.job, f.item, "verified_applied", target.directStatus, "Observed.", undefined, validate);
      await expect(pending).rejects.toBe(failure);
      expect(validate).toHaveBeenCalledOnce();
      expect(f.query).toHaveBeenCalledWith("ROLLBACK");
      expect(f.query).not.toHaveBeenCalledWith("COMMIT");
      if (mode === "submission") expect(f.query.mock.calls.some(([text]) => String(text).startsWith("INSERT INTO copilot_quarantine_jobs"))).toBe(true);
    });
  });

  describe("quarantine lease and cancellation persistence without a database", () => {
    it("renews the fenced lease for each newly begun item rather than timing out a whole 25-item job", async () => {
      const f = leaseFixture();
      await f.repository.beginItem(f.lease);
      await f.repository.beginItem(f.lease);
      const statements = f.query.mock.calls.map(([text]) => String(text));
      const renewals = statements.filter(text => text.startsWith("UPDATE copilot_quarantine_jobs SET lease_until="));
      expect(renewals).toHaveLength(2);
      expect(renewals[0]).toContain("clock_timestamp()+interval '120 seconds'");
      expect(statements.findIndex(text => text.includes("lease_until>clock_timestamp() FOR UPDATE")))
        .toBeLessThan(statements.indexOf(renewals[0]));
      expect(statements.indexOf(renewals[0])).toBeLessThan(statements.findIndex(text => text.includes("SET status='running'")));
      expect(f.client.release).toHaveBeenCalledTimes(2);
    });

    it("never renews an expired or replaced lease", async () => {
      const f = leaseFixture();
      f.query.mockImplementation(async () => f.result([]));
      await expect(f.repository.beginItem(f.lease)).rejects.toMatchObject({ code: "lease_lost" });
      expect(f.query.mock.calls.some(([text]) => String(text).includes("SET lease_until="))).toBe(false);
      expect(f.query).toHaveBeenCalledWith("ROLLBACK");
    });

    it("cancels recovered queued work before computing job status", async () => {
      const f = leaseFixture();
      f.job.cancel_requested = true;
      f.query.mockImplementation(async text => {
        const statement = String(text);
        if (statement.includes("FROM copilot_quarantine_jobs j WHERE")) return f.result([{ ...f.job, bytes: 1000 }]);
        if (statement.includes("SELECT id FROM bounded")) return f.result([{ id: f.item.id }]);
        return f.result([]);
      });
      await f.repository.recoverInterrupted(scope.tenantId);
      const statements = f.query.mock.calls.map(([text]) => String(text));
      const cancellation = statements.findIndex(text => text.includes("WHEN $2 THEN 'cancelled' ELSE 'queued' END"));
      expect(cancellation).toBeGreaterThan(statements.findIndex(text => text.includes("SELECT id FROM bounded")));
      expect(f.query.mock.calls[cancellation][1]).toEqual([f.item.id, true]);
      expect(cancellation).toBeLessThan(statements.findIndex(text => text.includes("UPDATE copilot_quarantine_jobs SET status=CASE")));
    });

    it("also applies persisted cancellation when unsent authorization-paused work is requeued", async () => {
      const f = leaseFixture();
      f.job.cancel_requested = true;
      f.query.mockImplementation(async text => {
        const statement = String(text);
        if (statement.startsWith("SELECT * FROM copilot_quarantine_jobs")) return f.result([f.job]);
        if (statement.includes("SET status='queued',correlation_id=NULL")) return f.result([{ id: f.item.id }]);
        return f.result([]);
      });
      await f.repository.pauseItemForAuthorization(f.lease, f.item);
      expect(f.query.mock.calls.some(([text]) => String(text).includes("status='queued' AND EXISTS(SELECT 1 FROM copilot_quarantine_jobs WHERE id=$1 AND cancel_requested)"))).toBe(true);
    });

    it("never offers resume for a cancelled legacy receipt even if queued rows remain", async () => {
      const f = fixture();
      f.query.mockReset().mockResolvedValueOnce(f.result([{
        ...f.job, cancel_requested: true, status: "waiting_authorization", deadline_at: new Date(Date.now() + 60_000),
      }])).mockResolvedValueOnce(f.result([{ ...f.item, status: "queued" }]));
      await expect(f.repository.get(scope, f.job.id)).resolves.toMatchObject({ canResume: false });
    });

    it("aggregates cancellation from cancelled items rather than relabelling committed results", async () => {
      const f = leaseFixture();
      f.job.cancel_requested = true;

      await f.repository.release(f.lease);

      const aggregate = f.query.mock.calls.find(([text]) => String(text).startsWith("UPDATE copilot_quarantine_jobs SET status=CASE"));
      expect(String(aggregate?.[0])).toContain("WHERE job_id=$1 AND status='cancelled') THEN 'cancelled'");
      expect(String(aggregate?.[0])).not.toContain("WHEN cancel_requested");
    });
  });

  it.each([
    { snapshotId: "11111111-1111-4111-8111-111111111111" },
    { resourceNativeIds: [target.resourceNativeId.toLowerCase()] },
    { confirmationHash: "f".repeat(64) },
    { action: "unquarantine" as const },
  ])("still rejects a different exact request: %j", async change => {
    const { repository } = fixture();
    await expect(repository.existingSubmission(scope, { ...identity, ...change })).rejects.toMatchObject({ code: "idempotency_mismatch" });
  });
});
