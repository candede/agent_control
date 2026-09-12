import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import type { AuthenticatedUser } from "../types/session.js";
import { CopilotStudioQuarantineCanaryRepository } from "./copilotStudioQuarantineCanaries.js";
import { CopilotStudioQuarantineRepository, createQuarantineConfirmation } from "./copilotStudioQuarantine.js";

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

  it("rejects the approving principal and invalidates authority revision drift", async () => {
    const sameActor = { ...administrator, roles: ["AgentControl.Admin"] as const };
    const sameActorApprovals = await approvals();
    await expect(canaries.claimCycle(sameActor, sameActorApprovals.original.id, sameActorApprovals.restoration.id, authority)).rejects.toMatchObject({ code: "separate_approval_required" });
    const stale = await approvals({ ...authority, configurationRevision: 2 });
    await expect(canaries.claimCycle(operator, stale.original.id, stale.restoration.id, authority)).rejects.toMatchObject({ code: "qualification_invalidated" });
  });

  it("atomically binds a claimed approval to one exact durable canary job", async () => {
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
  });

  it("allows operator retention to expire an unclaimed approval", async () => {
    const value = await approvals();
    await expect(fixture.operator.query("UPDATE copilot_quarantine_canary_approvals SET status='expired' WHERE id=$1", [value.original.id])).resolves.toMatchObject({ rowCount: 1 });
  });
});