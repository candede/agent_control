import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopilotStudioQuarantineCanaryRepository, type QuarantineCanaryApprovalInput } from "./copilotStudioQuarantineCanaries.js";
import type { AuthenticatedUser } from "../types/session.js";

const user: AuthenticatedUser = { tenantId: "tenant-a", homeAccountId: "executor", displayName: "Admin",
  username: "admin@example.invalid", roles: ["AgentControl.Admin"] };
const authority = { contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1 };
const originalId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const restorationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const input: QuarantineCanaryApprovalInput = {
  target: { resourceNativeId: "native-agent", displayName: "Canary agent", snapshotId: "11111111-1111-4111-8111-111111111111",
    inventoryObservedAt: "2026-09-09T19:00:00Z", inventoryExpiresAt: "2026-09-10T19:00:00Z",
    environmentId: "22222222-2222-4222-8222-222222222222", botId: "33333333-3333-4333-8333-333333333333",
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

describe("quarantine canary repository input contracts without a database", () => {
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

  it("claims case-insensitive UUIDs using PostgreSQL's canonical approval IDs", async () => {
    const f = fixture();
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
});
