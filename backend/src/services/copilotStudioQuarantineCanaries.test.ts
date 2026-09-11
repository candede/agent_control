import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { CopilotStudioQuarantineCanaryRepository } from "../db/copilotStudioQuarantineCanaries.js";
import { CopilotStudioQuarantineRepository } from "../db/copilotStudioQuarantine.js";
import { PowerPlatformInventoryRepository } from "../db/powerPlatformInventory.js";
import type { AuthenticatedUser } from "../types/session.js";
import { CopilotStudioQuarantineCanaryService } from "./copilotStudioQuarantineCanaries.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let canaries: CopilotStudioQuarantineCanaryRepository;
let jobs: CopilotStudioQuarantineRepository;
const authority = { contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1 };
const target = { resourceNativeId: "native-agent", displayName: "Canary agent", snapshotId: "11111111-1111-4111-8111-111111111111",
  inventoryObservedAt: "2026-09-09T19:00:00Z", inventoryExpiresAt: "2026-09-10T19:00:00Z", environmentId: "22222222-2222-4222-8222-222222222222",
  botId: "33333333-3333-4333-8333-333333333333", inventoryQuarantineState: false, inventoryQuarantinedAt: null };

beforeAll(async () => { fixture = await testDatabase(); canaries = new CopilotStudioQuarantineCanaryRepository(fixture.runtime); jobs = new CopilotStudioQuarantineRepository(fixture.runtime); });
afterAll(async () => { await fixture?.close(); });

function users(tenantId: string) {
  const administrator: AuthenticatedUser = { tenantId, homeAccountId: randomUUID(), displayName: "Administrator", username: "admin@example.invalid", roles: ["AgentControl.Administrator"] };
  const operator: AuthenticatedUser = { tenantId, homeAccountId: randomUUID(), displayName: "Operator", username: "operator@example.invalid", roles: ["AgentControl.Operator"] };
  return { administrator, operator };
}

async function approvals(administrator: AuthenticatedUser) {
  const original = await canaries.createApproved(administrator, { target, action: "quarantine", prestate: false, prestateProviderUpdatedAt: "2026-09-09T19:00:00.1234567Z", poststate: true, authority });
  const restoration = await canaries.createApproved(administrator, { target, action: "unquarantine", prestate: true, prestateProviderUpdatedAt: null, poststate: false, authority });
  return { original, restoration };
}

async function seedOperatorInventory(operator: AuthenticatedUser) {
  const inventory = new PowerPlatformInventoryRepository(fixture.runtime);
  const scope = { tenantId: operator.tenantId!, principalId: operator.homeAccountId };
  const job = await inventory.submit(scope, { idempotencyKey: `canary-operator-${randomUUID()}`, roleScope: "full", requestedTypes: ["microsoft.copilotstudio/agents"] });
  await inventory.markRunning(scope, job.id);
  await inventory.publish(scope, job.id, { resources: [{ tenantId: operator.tenantId!, nativeId: target.resourceNativeId, type: "microsoft.copilotstudio/agents",
    location: null, displayName: target.displayName, environmentId: target.environmentId, createdAt: null, createdBy: null, lastPublishedAt: null,
    sourceSystem: "power_platform", authoringTool: "Copilot Studio", creatorType: "unknown", agentKind: "copilot_studio_agent", lifecycle: "published",
    identityConfidence: "exact_native", identifiers: [{ kind: "power_platform_resource_id", value: target.resourceNativeId },
      { kind: "environment_id", value: target.environmentId }, { kind: "cds_bot_id", value: target.botId }], provenance: {}, details: {}, unknownFieldCount: 0 }],
    totalRecords: 1, pages: 1, unknownFieldCount: 0 });
  return (await inventory.getJob(scope, job.id))!.snapshotId!;
}

function service(operator: AuthenticatedUser, provider: { getStatus: ReturnType<typeof vi.fn>; setQuarantine: ReturnType<typeof vi.fn> }) {
  const dependencies = { revalidateUser: vi.fn(async () => operator), delegatedToken: vi.fn(async () => "ephemeral-token"), requireAvailable: vi.fn(async () => undefined),
    authorityContext: vi.fn(async () => authority), approvalAuthorityContext: vi.fn(async () => authority) };
  return new CopilotStudioQuarantineCanaryService(canaries, jobs, {} as never, provider as never, dependencies as never);
}

function provider(conflictBeforeRestoration = false, preserveTimestamp = false) {
  let state = false;
  let providerUpdatedAt = "2026-09-09T19:00:00.1234567Z";
  let reads = 0;
  let writes = 0;
  const getStatus = vi.fn(async () => {
    reads += 1;
    if (conflictBeforeRestoration && writes === 1 && reads === 4) providerUpdatedAt = "2026-09-09T19:00:02Z";
    return { environmentId: target.environmentId, botId: target.botId, isBotQuarantined: state, lastUpdateTimeUtc: providerUpdatedAt, observedAt: new Date().toISOString(), correlationId: randomUUID() };
  });
  const setQuarantine = vi.fn(async (_token: string, _target: unknown, requestedState: boolean) => {
    writes += 1;
    state = requestedState;
    if (!preserveTimestamp) providerUpdatedAt = `2026-09-09T19:00:0${writes}Z`;
    return { environmentId: target.environmentId, botId: target.botId, isBotQuarantined: state, lastUpdateTimeUtc: providerUpdatedAt, observedAt: new Date().toISOString(), correlationId: randomUUID() };
  });
  return { getStatus, setQuarantine };
}

describe.sequential("Copilot Studio quarantine full-cycle canaries", () => {
  it("qualifies only after both exact directions and verified restoration", async () => {
    const { administrator, operator } = users("canary-success");
    const approved = await approvals(administrator);
    const operatorSnapshotId = await seedOperatorInventory(operator);
    expect(operatorSnapshotId).not.toBe(approved.original.snapshotId);
    const fakeProvider = provider();
    const result = await service(operator, fakeProvider).execute(operator, approved.original.id, approved.restoration.id);
    expect(fakeProvider.setQuarantine.mock.calls.map(call => call[2])).toEqual([true, false]);
    expect(result).toMatchObject({ original: { status: "qualified" }, restoration: { status: "qualified" }, qualification: { qualified: true },
      jobs: { original: { status: "succeeded" }, restoration: { status: "succeeded" } } });
    expect(await jobs.isQualified({ tenantId: operator.tenantId! }, authority)).toBe(true);
  });

  it("stops before restoration POST and publishes no qualification after timestamp conflict", async () => {
    const { administrator, operator } = users("canary-conflict");
    const approved = await approvals(administrator);
    await seedOperatorInventory(operator);
    const fakeProvider = provider(true);
    await expect(service(operator, fakeProvider).execute(operator, approved.original.id, approved.restoration.id)).rejects.toMatchObject({ code: "canary_restoration_unverified" });
    expect(fakeProvider.setQuarantine.mock.calls.map(call => call[2])).toEqual([true]);
    expect((await canaries.list(administrator)).value.filter(value => [approved.original.id, approved.restoration.id].includes(value.id)))
      .toEqual(expect.arrayContaining([expect.objectContaining({ status: "conflict" }), expect.objectContaining({ status: "conflict" })]));
    expect(await jobs.isQualified({ tenantId: operator.tenantId! }, authority)).toBe(false);
  });

  it("does not qualify state flips that lack provider update timestamp evidence", async () => {
    const { administrator, operator } = users("canary-unchanged-timestamp");
    const approved = await approvals(administrator);
    await seedOperatorInventory(operator);
    const fakeProvider = provider(false, true);
    await expect(service(operator, fakeProvider).execute(operator, approved.original.id, approved.restoration.id))
      .rejects.toMatchObject({ code: "canary_cycle_unverified" });
    expect(await jobs.isQualified({ tenantId: operator.tenantId! }, authority)).toBe(false);
  });
});