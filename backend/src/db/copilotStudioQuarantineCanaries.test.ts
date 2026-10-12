import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import type { AuthenticatedUser } from "../types/session.js";
import { CopilotStudioQuarantineCanaryRepository } from "./copilotStudioQuarantineCanaries.js";
import { CopilotStudioQuarantineRepository, createQuarantineConfirmation } from "./copilotStudioQuarantine.js";
import { nativeInventoryFixture, reconcileInventoryFixture } from "../../scripts/inventoryFixtures.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let canaries: CopilotStudioQuarantineCanaryRepository;
let jobs: CopilotStudioQuarantineRepository;
const authority = { contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1 };
const administrator: AuthenticatedUser = { tenantId: "tenant-a", homeAccountId: "administrator-a", displayName: "Administrator", username: "admin@example.invalid", roles: ["AgentControl.Admin"] };
const operator: AuthenticatedUser = { tenantId: "tenant-a", homeAccountId: "operator-a", displayName: "Operator", username: "operator@example.invalid", roles: ["AgentControl.Admin"] };
const target = { resourceNativeId: "native-agent", displayName: "Canary agent", snapshotId: "11111111-1111-4111-8111-111111111111",
  inventoryObservedAt: "2026-09-09T19:00:00Z", inventoryExpiresAt: "2026-09-10T19:00:00Z", environmentId: "22222222-2222-4222-8222-222222222222",
  botId: "33333333-3333-4333-8333-333333333333", inventoryQuarantineState: false, inventoryQuarantinedAt: null };

beforeAll(async () => { fixture = await testDatabase(); canaries = new CopilotStudioQuarantineCanaryRepository(fixture.runtime); jobs = new CopilotStudioQuarantineRepository(fixture.runtime); });
afterAll(async () => { await fixture?.close(); });

async function approvals(revision = authority) {
  const original = await canaries.createApproved(administrator, { target, action: "quarantine", prestate: false, prestateProviderUpdatedAt: "2026-09-09T19:01:00.1234567Z", poststate: true, authority: revision });
  const restoration = await canaries.createApproved(administrator, { target, action: "unquarantine", prestate: true, prestateProviderUpdatedAt: null, poststate: false, authority: revision });
  return { original, restoration };
}

describe.sequential("Copilot Studio quarantine canary repository", () => {
  it("claims two exact inverse approvals for a separate Operator", async () => {
    const value = await approvals();
    const claimed = await canaries.claimCycle(operator, value.original.id, value.restoration.id, authority);
    expect(claimed).toMatchObject({ original: { status: "claimed", pairedApprovalId: value.restoration.id, actorPrincipalId: operator.homeAccountId }, restoration: { status: "claimed", pairedApprovalId: value.original.id } });
  });

  it("never completes directions belonging to different claimed cycles on the same target", async () => {
    const first = await approvals();
    await canaries.claimCycle(operator, first.original.id, first.restoration.id, authority);
    const second = await approvals();
    await canaries.claimCycle(operator, second.original.id, second.restoration.id, authority);

    await expect(canaries.completeCycle(operator, first.original.id, second.restoration.id, { status: "failed" }))
      .rejects.toMatchObject({ code: "canary_cycle_state" });
    const ids = [first.original.id, first.restoration.id, second.original.id, second.restoration.id];
    expect((await canaries.list(administrator)).value.filter(approval => ids.includes(approval.id)).map(approval => approval.status))
      .toEqual(["claimed", "claimed", "claimed", "claimed"]);
  });

  it("replaces source-cased approvals and admits a canonical approval for a source-cased canary target", async () => {
    const source = { ...target, environmentId: `Default-a${randomUUID().slice(1)}`.toUpperCase(), botId: `b${randomUUID().slice(1)}`.toUpperCase() };
    const canonical = { ...source, environmentId: source.environmentId.toLowerCase(), botId: source.botId.toLowerCase() };
    const approvalInput = { target: source, action: "quarantine" as const, prestate: false,
      prestateProviderUpdatedAt: "2026-09-09T19:01:00.1234567Z", poststate: true, authority };
    const first = await canaries.createApproved(administrator, approvalInput);
    const legacy = (await fixture.runtime.query<{ id: string }>(`INSERT INTO copilot_quarantine_canary_approvals
      (id,tenant_id,approved_by_principal_id,resource_native_id,display_name,snapshot_id,inventory_observed_at,environment_id,bot_id,
       action,prestate,prestate_provider_updated_at,poststate,contract_revision,permission_revision,configuration_revision,auth_mode)
      SELECT gen_random_uuid(),tenant_id,approved_by_principal_id,resource_native_id,display_name,snapshot_id,inventory_observed_at,
        upper(environment_id),upper(bot_id),action,prestate,prestate_provider_updated_at,poststate,contract_revision,permission_revision,
        configuration_revision,auth_mode FROM copilot_quarantine_canary_approvals WHERE id=$1 RETURNING id`, [first.id])).rows[0];
    const replacement = await canaries.createApproved(administrator, { ...approvalInput, target: canonical });
    const listed = (await canaries.list(administrator)).value;
    expect(listed.find(row => row.id === first.id)?.status).toBe("expired");
    expect(listed.find(row => row.id === legacy.id)?.status).toBe("expired");
    expect(replacement).toMatchObject({ environmentId: canonical.environmentId, botId: canonical.botId });
    const restoration = await canaries.createApproved(administrator, {
      ...approvalInput, action: "unquarantine", prestate: true, prestateProviderUpdatedAt: null, poststate: false,
    });
    await canaries.claimCycle(operator, replacement.id, restoration.id, authority);
    const scope = { tenantId: operator.tenantId!, principalId: operator.homeAccountId };
    const root = await nativeInventoryFixture(fixture.runtime, scope, [{
      nativeId: target.resourceNativeId, environmentId: canonical.environmentId, displayName: target.displayName, lifecycle: "published",
      identifiers: [{ kind: "power_platform_resource_id", value: target.resourceNativeId },
        { kind: "environment_id", value: canonical.environmentId }, { kind: "cds_bot_id", value: canonical.botId }],
      details: { isQuarantined: false, quarantinedAt: null },
    }]);
    await reconcileInventoryFixture(fixture.runtime, scope);
    const frozen = { ...source, snapshotId: root.baselineId, inventoryObservedAt: new Date().toISOString(), directStatus: {
      environmentId: canonical.environmentId, botId: canonical.botId, isBotQuarantined: false,
      lastUpdateTimeUtc: approvalInput.prestateProviderUpdatedAt, observedAt: new Date().toISOString(), correlationId: randomUUID(),
    } };
    const input = { action: "quarantine" as const, targets: [frozen], actor: { tenantId: scope.tenantId, homeAccountId: scope.principalId,
      displayName: operator.displayName, username: operator.username }, authority, requestPath: "/api/quarantine/canary-approvals/execute",
      canaryApprovalId: replacement.id };
    const job = await jobs.submit(scope, { ...input, idempotencyKey: randomUUID(), confirmationHash: createQuarantineConfirmation(input).confirmationHash });
    const lease = (await jobs.claim(scope, job.id, randomUUID()))!;
    const current = (await jobs.beginItem(lease))!;
    await expect(jobs.markSent(lease, current.item, authority)).resolves.toBeUndefined();
    await jobs.finishItem(lease, current.item, "inconclusive", { errorCode: "provider_timeout" });
    await jobs.release(lease);
  });

  it("rejects the approving principal and invalidates authority revision drift", async () => {
    const sameActor = { ...administrator, roles: ["AgentControl.Admin"] as const };
    const sameActorApprovals = await approvals();
    await expect(canaries.claimCycle(sameActor, sameActorApprovals.original.id, sameActorApprovals.restoration.id, authority)).rejects.toMatchObject({ code: "separate_approval_required" });
    const stale = await approvals({ ...authority, configurationRevision: 2 });
    await expect(canaries.claimCycle(operator, stale.original.id, stale.restoration.id, authority)).rejects.toMatchObject({ code: "qualification_invalidated" });
  });

  it("binds one exact canary job but never lets an older broader query override current confirmed absence", async () => {
    const value = await approvals();
    const claimed = await canaries.claimCycle(operator, value.original.id, value.restoration.id, authority);
    const frozen = { ...target, directStatus: { environmentId: target.environmentId, botId: target.botId, isBotQuarantined: false,
      lastUpdateTimeUtc: claimed.original.prestateProviderUpdatedAt!, observedAt: new Date().toISOString(), correlationId: randomUUID() } };
    const input = { action: "quarantine" as const, targets: [frozen], actor: { tenantId: "tenant-a", homeAccountId: "operator-a", displayName: "Operator", username: "operator@example.invalid" },
      authority, requestPath: "/api/quarantine/canary-approvals/execute", canaryApprovalId: claimed.original.id };
    const confirmation = createQuarantineConfirmation(input);
    const job = await jobs.submit({ tenantId: "tenant-a", principalId: "operator-a" }, { ...input, idempotencyKey: randomUUID(), confirmationHash: confirmation.confirmationHash });
    expect(job).toMatchObject({ isCanary: true, action: "quarantine", total: 1 });
    await expect(jobs.submit({ tenantId: "tenant-a", principalId: "operator-a" }, { ...input, idempotencyKey: randomUUID(), confirmationHash: confirmation.confirmationHash }))
      .rejects.toMatchObject({ code: "qualification_invalidated" });

    const scope = { tenantId: operator.tenantId, principalId: operator.homeAccountId };
    for (const [types, nativeId] of [
      [["microsoft.copilotstudio/agents", "microsoft.powerplatform/environments"], target.resourceNativeId],
      [["microsoft.copilotstudio/agents"], "other-native-agent"],
    ] as const) {
      await nativeInventoryFixture(fixture.runtime, scope, [{
          tenantId: scope.tenantId, nativeId, type: "microsoft.copilotstudio/agents", location: null,
          displayName: "Canary source", environmentId: target.environmentId, createdAt: null, createdBy: null, lastPublishedAt: null,
          sourceSystem: "power_platform", authoringTool: "Copilot Studio", creatorType: "unknown", agentKind: "copilot_studio_agent",
          lifecycle: "published", identityConfidence: "exact_native", provenance: {}, details: {}, unknownFieldCount: 0,
          identifiers: [{ kind: "power_platform_resource_id", value: nativeId }, { kind: "environment_id", value: target.environmentId },
            { kind: "cds_bot_id", value: nativeId === target.resourceNativeId ? target.botId : randomUUID() }],
        }], { resourceTypes: [...types], observedAt: new Date(Date.now() - (types.length === 2 ? 300_000 : 0)) });
      await reconcileInventoryFixture(fixture.runtime, scope);
    }
    const lease = await jobs.claim(scope, job.id, randomUUID());
    const current = await jobs.beginItem(lease!);
    await expect(jobs.markSent(lease!, current!.item, authority)).rejects.toMatchObject({ code: "quarantine_target_unavailable" });
    expect((await fixture.runtime.query("SELECT sent_at FROM copilot_quarantine_job_items WHERE id=$1", [current!.item.id])).rows[0])
      .toEqual({ sent_at: null });
  });

  it("allows operator retention to expire an unclaimed approval", async () => {
    const value = await approvals();
    await expect(fixture.operator.query("UPDATE copilot_quarantine_canary_approvals SET status='expired' WHERE id=$1", [value.original.id])).resolves.toMatchObject({ rowCount: 1 });
  });
});