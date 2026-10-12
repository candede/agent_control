import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopilotStudioQuarantineCanaryRepository, type QuarantineCanaryApprovalInput } from "./copilotStudioQuarantineCanaries.js";
import type { AuthenticatedUser } from "../types/session.js";
import { AppError } from "../errors.js";

const user: AuthenticatedUser = { tenantId: "tenant-a", homeAccountId: "executor", displayName: "Admin",
  username: "admin@example.invalid", roles: ["AgentControl.Admin"] };
const authority = { contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1 };
const originalId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const restorationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const input: QuarantineCanaryApprovalInput = {
  target: { resourceNativeId: "native-agent", displayName: "Canary agent", snapshotId: "11111111-1111-4111-8111-111111111111",
    inventoryObservedAt: "2026-09-09T19:00:00Z", inventoryExpiresAt: "2026-09-10T19:00:00Z",
    environmentId: "Default-ABCDEFAB-2222-4222-8222-222222222222", botId: "CDEFABCD-3333-4333-8333-333333333333",
    inventoryQuarantineState: false, inventoryQuarantinedAt: null },
  action: "quarantine", prestate: false, prestateProviderUpdatedAt: "2026-09-09T19:00:00.1234567Z", poststate: true, authority,
};

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const database = new pg.Pool();
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  const connect = vi.fn(async () => client);
  vi.spyOn(database, "connect").mockImplementation(connect);
  const result = (rows: object[] = []) => ({ command: "", oid: 0, fields: [], rowCount: rows.length, rows });
  const query = vi.fn(async (_text: unknown, _values?: unknown) => result());
  vi.spyOn(client, "query").mockImplementation(query);
  const now = new Date();
  const row = {
    id: originalId, tenant_id: user.tenantId, approved_by_principal_id: "approver", resource_native_id: input.target.resourceNativeId,
    display_name: input.target.displayName, snapshot_id: input.target.snapshotId, inventory_observed_at: now,
    environment_id: input.target.environmentId, bot_id: input.target.botId, action: "quarantine", prestate: false,
    prestate_provider_updated_at: input.prestateProviderUpdatedAt, poststate: true,
    contract_revision: authority.contractRevision, permission_revision: authority.permissionRevision, configuration_revision: "1",
    auth_mode: "delegated", status: "approved", paired_approval_id: null, actor_principal_id: null, job_id: null,
    approved_at: now, attempted_at: null, finished_at: null, approval_expires_at: new Date(now.getTime() + 60_000),
    evidence_expires_at: new Date(now.getTime() + 60_000), error_code: null,
  };
  const inverse = { ...row, id: restorationId, action: "unquarantine", prestate: true,
    prestate_provider_updated_at: null, poststate: false };
  return { repository: new CopilotStudioQuarantineCanaryRepository(database), connect, query, result, row, inverse };
}

function verifiedCycle(f: ReturnType<typeof fixture>) {
  const original = { ...f.row, status: "claimed", actor_principal_id: user.homeAccountId, paired_approval_id: restorationId, job_id: originalId };
  const restoration = { ...f.inverse, status: "claimed", actor_principal_id: user.homeAccountId, paired_approval_id: originalId, job_id: restorationId,
    environment_id: f.inverse.environment_id.toLowerCase(), bot_id: f.inverse.bot_id.toLowerCase() };
  const originalJob = { ...original, environment_id: original.environment_id.toLowerCase(), bot_id: original.bot_id.toLowerCase(),
    canary_approval_id: originalId, status: "succeeded", item_status: "succeeded", requested_state: true, observed_state: true,
    observed_provider_updated_at: "2026-09-09T19:00:01Z" };
  const restorationJob = { ...restoration, environment_id: restoration.environment_id.toUpperCase(), bot_id: restoration.bot_id.toUpperCase(),
    canary_approval_id: restorationId, status: "succeeded", item_status: "succeeded",
    prestate_provider_updated_at: originalJob.observed_provider_updated_at, requested_state: false, observed_state: false,
    observed_provider_updated_at: "2026-09-09T19:00:02Z" };
  f.query.mockImplementation(async text => {
    const statement = String(text);
    if (statement.startsWith("SELECT * FROM copilot_quarantine_canary_approvals")) return f.result([original, restoration]);
    if (statement.startsWith("SELECT job.id")) return f.result([originalJob, restorationJob]);
    if (statement.startsWith("UPDATE copilot_quarantine_canary_approvals SET status=$4")) return f.result([
      { ...original, status: "qualified" }, { ...restoration, status: "qualified" },
    ]);
    return f.result();
  });
  return { original, restoration, originalJob, restorationJob };
}

describe("quarantine canary repository input contracts without a database", () => {
  it("serializes replacement approvals and stores one canonical native GUID identity", async () => {
    const f = fixture();
    f.query.mockImplementation(async text => String(text).startsWith("INSERT INTO copilot_quarantine_canary_approvals")
      ? f.result([f.row]) : f.result());
    await f.repository.createApproved(user, input);
    await f.repository.createApproved(user, { ...input, target: { ...input.target,
      environmentId: input.target.environmentId.toLowerCase(), botId: input.target.botId.toLowerCase() } });
    const locks = f.query.mock.calls.filter(([text]) => String(text).startsWith("SELECT pg_advisory_xact_lock"));
    expect(locks).toHaveLength(2);
    expect(locks[0][1]).toEqual(locks[1][1]);
    const insertions = f.query.mock.calls.filter(([text]) => String(text).startsWith("INSERT INTO copilot_quarantine_canary_approvals"));
    expect(insertions.every(([, values]) => Array.isArray(values) && values[7] === input.target.environmentId.toLowerCase()
      && values[8] === input.target.botId.toLowerCase())).toBe(true);
  });

  it.each(["2026-02-30T19:00:00Z", "2025-02-29T19:00:00Z", "2026-04-31T19:00:00Z", "2026-09-09T24:00:00Z"])(
    "rejects calendar rollover in approval evidence: %s", async prestateProviderUpdatedAt => {
      const f = fixture();
      await expect(f.repository.createApproved(user, { ...input, prestateProviderUpdatedAt }))
        .rejects.toMatchObject({ code: "invalid_qualification_state" });
      expect(f.connect).not.toHaveBeenCalled();
    },
  );

  it.each([null, "2024-02-29T19:00:00.1234567Z", "2026-09-09T19:00:00Z"])(
    "preserves valid exact timestamp evidence or the future inverse marker: %s", async prestateProviderUpdatedAt => {
      const f = fixture();
      f.query.mockResolvedValueOnce(f.result()).mockResolvedValueOnce(f.result()).mockResolvedValueOnce(f.result())
        .mockResolvedValueOnce(f.result([{ ...f.row, prestate_provider_updated_at: prestateProviderUpdatedAt }]));
      const approval = await f.repository.createApproved(user, { ...input, prestateProviderUpdatedAt });
      expect(approval.prestateProviderUpdatedAt).toBe(prestateProviderUpdatedAt);
      expect(f.query.mock.calls[3][1]).toEqual(expect.arrayContaining([
        prestateProviderUpdatedAt, authority.contractRevision, authority.permissionRevision,
      ]));
    },
  );

  it("claims case-insensitive approval IDs and native target GUID aliases", async () => {
    const f = fixture();
    f.inverse.environment_id = f.row.environment_id.toLowerCase();
    f.inverse.bot_id = f.row.bot_id.toLowerCase();
    f.query.mockResolvedValueOnce(f.result()).mockResolvedValueOnce(f.result([f.row, f.inverse]))
      .mockResolvedValueOnce(f.result([
        { ...f.row, status: "claimed", actor_principal_id: user.homeAccountId, paired_approval_id: restorationId },
        { ...f.inverse, status: "claimed", actor_principal_id: user.homeAccountId, paired_approval_id: originalId },
      ]));
    await expect(f.repository.claimCycle(user, originalId.toUpperCase(), restorationId.toUpperCase(), authority))
      .resolves.toMatchObject({ original: { id: originalId }, restoration: { id: restorationId } });
    expect(f.query.mock.calls[1][1]).toEqual([[originalId, restorationId], user.tenantId]);
  });

  it("completes case-insensitive UUIDs using the same canonical pair", async () => {
    const f = fixture();
    const original = { ...f.row, status: "claimed", actor_principal_id: user.homeAccountId, paired_approval_id: restorationId };
    const restoration = { ...f.inverse, status: "claimed", actor_principal_id: user.homeAccountId, paired_approval_id: originalId };
    f.query.mockResolvedValueOnce(f.result()).mockResolvedValueOnce(f.result([original, restoration]))
      .mockResolvedValueOnce(f.result([{ ...original, status: "failed" }, { ...restoration, status: "failed" }]));
    await expect(f.repository.completeCycle(user, originalId.toUpperCase(), restorationId.toUpperCase(), { status: "failed" }))
      .resolves.toMatchObject({ original: { id: originalId, status: "failed" }, restoration: { id: restorationId, status: "failed" } });
    expect(f.query.mock.calls[1][1]).toEqual([[originalId, restorationId], user.tenantId, user.homeAccountId]);
  });

  it("qualifies verified inverse jobs across GUID casing aliases and stores canonical target evidence", async () => {
    const f = fixture();
    verifiedCycle(f);
    await expect(f.repository.completeCycle(user, originalId, restorationId, { status: "qualified" }, authority))
      .resolves.toMatchObject({ original: { status: "qualified" }, restoration: { status: "qualified" } });
    const qualification = f.query.mock.calls.find(([text]) => String(text).startsWith("INSERT INTO copilot_quarantine_qualifications"));
    expect(qualification?.[1]).toEqual([
      user.tenantId, input.target.environmentId.toLowerCase(), input.target.botId.toLowerCase(), originalId, restorationId,
      originalId, restorationId, authority.contractRevision, authority.permissionRevision, "1",
    ]);
  });

  it.each((["qualified", "failed"] as const).flatMap(status =>
    (["original", "restoration"] as const).map(direction => ({ status, direction }))))(
    "does not publish $status completion for approvals from different claimed pairs ($direction)", async ({ status, direction }) => {
      const f = fixture();
      const cycle = verifiedCycle(f);
      cycle[direction].paired_approval_id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

      await expect(f.repository.completeCycle(user, originalId, restorationId, { status }, authority).then(() => "completed"))
        .rejects.toMatchObject({ code: "canary_cycle_state" });

      expect(f.query.mock.calls.some(([text]) => String(text).startsWith("INSERT INTO copilot_quarantine_qualifications")
        || String(text).startsWith("UPDATE copilot_quarantine_canary_approvals SET status=$4"))).toBe(false);
      expect(f.query).toHaveBeenCalledWith("ROLLBACK");
      expect(f.query).not.toHaveBeenCalledWith("COMMIT");
    },
  );

  it.each(["approval environment", "approval bot", "job environment", "job bot"] as const)(
    "never qualifies a different %s GUID", async mismatch => {
      const f = fixture();
      const cycle = verifiedCycle(f);
      const row = mismatch.startsWith("approval") ? cycle.restoration : cycle.restorationJob;
      if (mismatch.endsWith("environment")) row.environment_id = "11111111-1111-4111-8111-111111111111";
      else row.bot_id = "11111111-1111-4111-8111-111111111111";
      await expect(f.repository.completeCycle(user, originalId, restorationId, { status: "qualified" }, authority))
        .rejects.toMatchObject({ code: mismatch.startsWith("approval") ? "canary_cycle_state" : "canary_cycle_unverified" });
      expect(f.query.mock.calls.some(([text]) => String(text).startsWith("INSERT INTO copilot_quarantine_qualifications"))).toBe(false);
      expect(f.query).toHaveBeenCalledWith("ROLLBACK");
    },
  );

  it.each(["approval", "claim", "qualification"] as const)("rolls back %s when the initiating session expires before commit", async mode => {
    const f = fixture(), failure = new AppError(401, "unauthorized", "The initiating session was superseded.");
    const validate = vi.fn(() => { throw failure; });
    const original = { ...f.row, status: "claimed", actor_principal_id: user.homeAccountId, paired_approval_id: restorationId, job_id: originalId };
    const restoration = { ...f.inverse, status: "claimed", actor_principal_id: user.homeAccountId, paired_approval_id: originalId, job_id: restorationId };
    f.query.mockImplementation(async text => {
      const statement = String(text);
      if (statement.startsWith("INSERT INTO copilot_quarantine_canary_approvals")) return f.result([f.row]);
      if (statement.startsWith("SELECT * FROM copilot_quarantine_canary_approvals")) return f.result(
        mode === "claim" ? [f.row, f.inverse] : [original, restoration]);
      if (statement.startsWith("UPDATE copilot_quarantine_canary_approvals SET status='claimed'")) return f.result([original, restoration]);
      if (statement.startsWith("SELECT job.id")) return f.result([
        { ...original, id: originalId, canary_approval_id: originalId, status: "succeeded", item_status: "succeeded",
          requested_state: true, observed_state: true, observed_provider_updated_at: "2026-09-09T19:00:01Z" },
        { ...restoration, id: restorationId, canary_approval_id: restorationId, status: "succeeded", item_status: "succeeded",
          prestate_provider_updated_at: "2026-09-09T19:00:01Z", requested_state: false, observed_state: false,
          observed_provider_updated_at: "2026-09-09T19:00:02Z" },
      ]);
      if (statement.startsWith("UPDATE copilot_quarantine_canary_approvals SET status=$4")) return f.result([
        { ...original, status: "qualified" }, { ...restoration, status: "qualified" },
      ]);
      return f.result();
    });
    const pending = mode === "approval" ? f.repository.createApproved(user, input, validate)
      : mode === "claim" ? f.repository.claimCycle(user, originalId, restorationId, authority, validate)
        : f.repository.completeCycle(user, originalId, restorationId, { status: "qualified" }, authority, validate);
    await expect(pending).rejects.toBe(failure);
    expect(validate).toHaveBeenCalledOnce();
    expect(f.query).toHaveBeenCalledWith("ROLLBACK");
    expect(f.query).not.toHaveBeenCalledWith("COMMIT");
  });
});
