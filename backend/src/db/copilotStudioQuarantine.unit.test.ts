import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopilotStudioQuarantineRepository, createQuarantineConfirmation, type QuarantineItemRow, type QuarantineJobRow } from "./copilotStudioQuarantine.js";

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
    deadline_at: now, expires_at: new Date(now.getTime() + 60_000),
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
    const query = vi.fn(async (text: unknown, _values?: unknown) => {
      if (typeof text === "string" && text.startsWith("SELECT * FROM copilot_quarantine_jobs")) return f.result([f.job]);
      if (typeof text === "string" && text.startsWith("SELECT * FROM copilot_quarantine_job_items")) return f.result([{ ...f.item, status: "queued", sent_at: null }]);
      return f.result([]);
    });
    vi.spyOn(client, "query").mockImplementation(query);
    return { ...f, query, client, lease: { jobId: f.job.id, scope, owner: "worker", version: 1 } };
  }

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
      await f.repository.recoverInterrupted();
      const statements = f.query.mock.calls.map(([text]) => String(text));
      const cancellation = statements.findIndex(text => text.includes("SET status='cancelled',error_code='cancelled'"));
      expect(cancellation).toBeGreaterThan(statements.findIndex(text => text.includes("SET status=CASE WHEN sent_at IS NULL")));
      expect(statements[cancellation]).toContain("status='queued'");
      expect(statements[cancellation]).toContain("AND cancel_requested");
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
